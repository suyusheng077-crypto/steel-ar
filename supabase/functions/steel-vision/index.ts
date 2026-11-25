// 鋼構 AR 檢查：把一張現場照片交給 AI，判斷拍到的是側面還是端面，並回傳鋼梁幾個角的大概位置。
// 需要在 Supabase 的 Edge Function Secrets 設定：
//   ANTHROPIC_API_KEY  你的 Claude API 金鑰
//   STEEL_AR_CODE      自訂的通行碼（App 的「設定」裡要輸入同一組）
// 選填：STEEL_AR_MODEL（預設 claude-sonnet-5-5）、STEEL_AR_ORIGINS（允許的網站來源，逗號分隔）
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const DEFAULT_ORIGINS = ["https://suyusheng077-crypto.github.io"];
const hits = new Map<string, number[]>();

function cors(origin: string | null) {
  const allow = (Deno.env.get("STEEL_AR_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const list = allow.length ? allow : DEFAULT_ORIGINS;
  const ok = origin && list.includes(origin) ? origin : list[0];
  return {
    "Access-Control-Allow-Origin": ok,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const PROMPT = (m: Record<string, unknown>) => `You are helping a steel-fabrication inspection app locate ONE steel beam (an I/H-section girder) in a workshop photo.

Target member: built-up H-section, depth ${m.H} mm, flange width ${m.B} mm, web ${m.tw} mm, flange ${m.tf} mm, length ${m.L} mm.${m.studs ? " The TOP flange carries a row of shear studs." : ""}${m.lugs ? " Lifting lugs stand on the top flange." : ""}
The beam may stand upright (web vertical) or lie on its side (web horizontal). The scene may be dark and cluttered with cranes, buildings and other steel. Pick the beam that is most prominent / closest to the camera and matches these proportions.

Decide which face the camera mainly sees:
- "side": the camera looks at the web from the side, the beam runs across the picture.
- "end": the camera stands near one end and looks along the beam's length, so the I-shaped end section faces the camera.

Return ONLY a JSON object, no prose, no code fence:
{"found": true|false, "view": "side"|"end", "points": [[x,y],[x,y],[x,y],[x,y]], "end_visible": true|false, "confidence": 0..1, "note": "<one short sentence>"}

Coordinates are fractions of image width and height, origin top-left, x to the right, y down, in the range 0..1.

For "side", points are, in this order:
 1. the corner where the camera-side edge of the TOP flange meets the visible beam end
 2. another point far along that same top-flange edge
 3. a point far along the camera-side edge of the BOTTOM flange (roughly below point 2)
 4. the corner where the bottom-flange edge meets the same beam end as point 1
If no beam end is in the picture, set "end_visible": false and put points 1 and 4 near one side of the visible length, 2 and 3 near the other.

For "end", points are the four outer corners of the I-shaped end section, in this order: the two outer corners of the TOP flange, then the two outer corners of the BOTTOM flange, going clockwise as seen in the picture (top-flange first corner, top-flange second corner, bottom-flange corner under the second, bottom-flange corner under the first). "Top flange" means the flange with studs or lugs if you can tell; otherwise the upper one, or the left one if the beam lies on its side.

If you cannot find such a beam, return {"found": false, "note": "..."}.`;

Deno.serve(async (req: Request) => {
  const h = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "method" }, 405, h);

  const code = Deno.env.get("STEEL_AR_CODE"), key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!code || !key) return json({ error: "not_configured" }, 503, h);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "?";
  const now = Date.now(), recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 12) return json({ error: "rate_limited" }, 429, h);
  recent.push(now); hits.set(ip, recent);

  let body: { code?: string; image?: string; member?: Record<string, unknown> };
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400, h); }
  if (typeof body.code !== "string" || !same(body.code, code)) return json({ error: "bad_code" }, 401, h);
  if (typeof body.image !== "string" || body.image.length < 1000 || body.image.length > 1_600_000 || !/^[A-Za-z0-9+/=]+$/.test(body.image)) {
    return json({ error: "bad_image" }, 400, h);
  }
  const m = body.member ?? {};
  for (const k of ["H", "B", "tw", "tf", "L"]) if (typeof m[k] !== "number" || !isFinite(m[k] as number)) return json({ error: "bad_member" }, 400, h);
  const member = { H: m.H, B: m.B, tw: m.tw, tf: m.tf, L: m.L, studs: !!m.studs, lugs: !!m.lugs };

  let r: Response;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("STEEL_AR_MODEL") ?? "claude-sonnet-5-5",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: body.image } },
            { type: "text", text: PROMPT(member) },
          ],
        }],
      }),
    });
  } catch (_e) {
    return json({ error: "upstream_unreachable" }, 502, h);
  }
  if (!r.ok) return json({ error: "upstream", status: r.status }, 502, h);

  const out = await r.json();
  const text = (out.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return json({ error: "no_json" }, 502, h);
  let res: Record<string, unknown>;
  try { res = JSON.parse(text.slice(a, b + 1)); } catch { return json({ error: "no_json" }, 502, h); }

  if (!res.found) return json({ found: false, note: String(res.note ?? "").slice(0, 200) }, 200, h);
  const pts = res.points;
  const valid = Array.isArray(pts) && pts.length === 4 && pts.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && isFinite(v) && v >= -0.5 && v <= 1.5));
  if (!valid || (res.view !== "side" && res.view !== "end")) return json({ error: "bad_shape" }, 502, h);
  return json({
    found: true, view: res.view, points: pts, end_visible: res.end_visible !== false,
    confidence: typeof res.confidence === "number" ? res.confidence : null, note: String(res.note ?? "").slice(0, 200),
  }, 200, h);
});
