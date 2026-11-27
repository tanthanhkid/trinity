#!/usr/bin/env bash
# Smoke MCP end-to-end: login -> đăng ký client OAuth (DCR) -> authorize PKCE (context + decision bằng JWT đã login,
# redirect loopback, không trình duyệt) -> đổi code lấy access token -> MCP initialize / tools/list / get_social_post_stats.
# Dùng: server/scripts/smoke-mcp.sh BASE_URL EMAIL MAT_KHAU      (hoặc biến BASE_URL, SMOKE_EMAIL, SMOKE_PASSWORD)
# Server phải chạy với INTEGRATIONS_MCP_ENABLED=true, INTEGRATIONS_PUBLIC_BASE_URL=<BASE_URL> (http loopback chỉ khi
# NODE_ENV=development/test), INTEGRATIONS_SECRET_KEY. Cần bash, curl, python3. Không in token/mật khẩu.
# Biến tuỳ chọn: EXPECT_SOCIAL (mặc định 25) — số tool nhóm đăng bài; EXPECT_TOTAL — nếu đặt thì kiểm tổng.
set -euo pipefail

BASE="${1:-${BASE_URL:-}}"; EMAIL="${2:-${SMOKE_EMAIL:-}}"; PASS="${3:-${SMOKE_PASSWORD:-}}"
[ -n "$BASE" ] && [ -n "$EMAIL" ] && [ -n "$PASS" ] || { echo "Dùng: $0 BASE_URL EMAIL MAT_KHAU" >&2; exit 2; }
BASE="${BASE%/}"
EXPECT_SOCIAL="${EXPECT_SOCIAL:-25}"
REDIRECT="http://127.0.0.1:8976/callback"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

fail() { echo "FAIL [$1] $2" >&2; exit 1; }
ok() { echo "OK   [$1] $2"; }

# Gửi JSON bằng file (không để mật khẩu/token lên dòng lệnh). req METHOD URL BODYFILE|- [header...] -> $T/out, in mã HTTP
req() {
  local m="$1" u="$2" b="$3"; shift 3
  local args=(-sS -m 60 -o "$T/out" -w '%{http_code}' -X "$m" "$u")
  [ "$b" != "-" ] && args+=(--data-binary "@$b")
  local h; for h in "$@"; do args+=(-H "$h"); done
  curl "${args[@]}"
}
py() { python3 -I -c "$1" "${@:2}"; }

# 1. login ------------------------------------------------------------------
py 'import json,sys;json.dump({"email":sys.argv[1],"password":sys.argv[2]},open(sys.argv[3],"w"))' "$EMAIL" "$PASS" "$T/login.json"
code=$(req POST "$BASE/api/v1/auth/login" "$T/login.json" 'Content-Type: application/json')
[ "$code" = 200 ] || fail login "HTTP $code"
JWT=$(py 'import json;print(json.load(open("'"$T"'/out")).get("access_token",""))')
[ -n "$JWT" ] || fail login "không có access_token"
ok login "HTTP 200, jwt dài ${#JWT}"

# 2. đăng ký client (DCR, public client + PKCE) ------------------------------
py 'import json,sys;json.dump({"client_name":"smoke-mcp","redirect_uris":[sys.argv[1]],"grant_types":["authorization_code","refresh_token"],"token_endpoint_auth_method":"none"},open(sys.argv[2],"w"))' "$REDIRECT" "$T/reg.json"
code=$(req POST "$BASE/api/v1/oauth/register" "$T/reg.json" 'Content-Type: application/json')
[ "$code" = 201 ] || fail register "HTTP $code (MCP/OAuth chưa bật? cần INTEGRATIONS_MCP_ENABLED + INTEGRATIONS_PUBLIC_BASE_URL)"
CID=$(py 'import json;print(json.load(open("'"$T"'/out")).get("client_id",""))')
[ -n "$CID" ] || fail register "không có client_id"
ok register "client_id dài ${#CID}"

# 3. PKCE + authorize/context + authorize/decision ---------------------------
VERIFIER=$(py 'import secrets;print(secrets.token_urlsafe(48))')
CHAL=$(py 'import sys,hashlib,base64;print(base64.urlsafe_b64encode(hashlib.sha256(sys.argv[1].encode()).digest()).rstrip(b"=").decode())' "$VERIFIER")
STATE=$(py 'import secrets;print(secrets.token_hex(8))')
py 'import json,sys
p={"client_id":sys.argv[1],"redirect_uri":sys.argv[2],"response_type":"code","code_challenge":sys.argv[3],"code_challenge_method":"S256","scope":"crm.read crm.write","state":sys.argv[4],"resource":sys.argv[5]+"/api/v1/mcp"}
json.dump({"params":p},open(sys.argv[6],"w"))' "$CID" "$REDIRECT" "$CHAL" "$STATE" "$BASE" "$T/ctx.json"
code=$(req POST "$BASE/api/v1/oauth/authorize/context" "$T/ctx.json" 'Content-Type: application/json' "Authorization: Bearer $JWT")
[ "$code" = 200 ] || fail authorize-context "HTTP $code"
CONSENT=$(py 'import json;d=json.load(open("'"$T"'/out"));print(d.get("consent_token","") if d.get("ok") else "")')
[ -n "$CONSENT" ] || fail authorize-context "ok=false hoặc thiếu consent_token"
ok authorize-context "consent_token dài ${#CONSENT}"

py 'import json,sys
d=json.load(open(sys.argv[1]));d["approve"]=True;d["consent_token"]=sys.argv[2];json.dump(d,open(sys.argv[3],"w"))' "$T/ctx.json" "$CONSENT" "$T/dec.json"
code=$(req POST "$BASE/api/v1/oauth/authorize/decision" "$T/dec.json" 'Content-Type: application/json' "Authorization: Bearer $JWT")
[ "$code" = 200 ] || fail authorize-decision "HTTP $code"
CODE=$(py 'import json,sys,urllib.parse as u
r=json.load(open("'"$T"'/out")).get("redirect_to","")
q=u.parse_qs(u.urlparse(r).query)
if q.get("state",[""])[0]!=sys.argv[1]: print("")
else: print(q.get("code",[""])[0])' "$STATE")
[ -n "$CODE" ] || fail authorize-decision "redirect_to không có code hoặc state sai"
ok authorize-decision "code dài ${#CODE}, state khớp"

# 4. đổi code lấy access token -------------------------------------------------
py 'import json,sys;json.dump({"grant_type":"authorization_code","code":sys.argv[1],"code_verifier":sys.argv[2],"redirect_uri":sys.argv[3],"client_id":sys.argv[4],"resource":sys.argv[5]+"/api/v1/mcp"},open(sys.argv[6],"w"))' "$CODE" "$VERIFIER" "$REDIRECT" "$CID" "$BASE" "$T/tok.json"
code=$(req POST "$BASE/api/v1/oauth/token" "$T/tok.json" 'Content-Type: application/json')
[ "$code" = 200 ] || fail token "HTTP $code"
AT=$(py 'import json;print(json.load(open("'"$T"'/out")).get("access_token",""))')
[ -n "$AT" ] || fail token "không có access_token"
ok token "access token dài ${#AT}"

# 5. MCP -------------------------------------------------------------------------
MCP="$BASE/api/v1/mcp"
H1='Content-Type: application/json'; H2='Accept: application/json, text/event-stream'; H3="Authorization: Bearer $AT"
# Thân trả về JSON hoặc SSE (`data: {...}`): rút JSON-RPC đầu tiên.
rpc_json() { py 'import sys,json
t=open(sys.argv[1]).read().strip()
if not t.startswith("{"):
    t="".join(l[5:].strip() for l in t.splitlines() if l.startswith("data:"))
print(json.dumps(json.loads(t)))' "$T/out"; }

echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-mcp","version":"1"}}}' > "$T/m1.json"
code=$(req POST "$MCP" "$T/m1.json" "$H1" "$H2" "$H3")
[ "$code" = 200 ] || fail initialize "HTTP $code"
rpc_json | py 'import sys,json;d=json.load(sys.stdin);r=d.get("result") or sys.exit("không có result");print("OK   [initialize] "+r["serverInfo"]["name"]+" "+r["serverInfo"]["version"]+" proto "+r["protocolVersion"])' || fail initialize "phản hồi sai"

echo '{"jsonrpc":"2.0","method":"notifications/initialized"}' > "$T/m2.json"
req POST "$MCP" "$T/m2.json" "$H1" "$H2" "$H3" >/dev/null || true

echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' > "$T/m3.json"
code=$(req POST "$MCP" "$T/m3.json" "$H1" "$H2" "$H3")
[ "$code" = 200 ] || fail tools/list "HTTP $code"
rpc_json | EXPECT_SOCIAL="$EXPECT_SOCIAL" EXPECT_TOTAL="${EXPECT_TOTAL:-}" py 'import sys,json,os,re
d=json.load(sys.stdin);tools=[t["name"] for t in (d.get("result") or {}).get("tools",[])]
if not tools: sys.exit("FAIL [tools/list] không có tool")
soc=[n for n in tools if re.search(r"social|queue_slots|recurring_post|update_scheduled_post",n)]
if "get_social_post_stats" not in tools: sys.exit("FAIL [tools/list] thiếu get_social_post_stats")
if len(soc)!=int(os.environ["EXPECT_SOCIAL"]): sys.exit("FAIL [tools/list] nhóm đăng bài %d, kỳ vọng %s: %s"%(len(soc),os.environ["EXPECT_SOCIAL"],", ".join(soc)))
if os.environ.get("EXPECT_TOTAL") and len(tools)!=int(os.environ["EXPECT_TOTAL"]): sys.exit("FAIL [tools/list] tổng %d, kỳ vọng %s"%(len(tools),os.environ["EXPECT_TOTAL"]))
print("OK   [tools/list] tổng %d tool, nhóm đăng bài %d"%(len(tools),len(soc)))' || fail tools/list "kiểm số tool"

echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_social_post_stats","arguments":{}}}' > "$T/m4.json"
code=$(req POST "$MCP" "$T/m4.json" "$H1" "$H2" "$H3")
[ "$code" = 200 ] || fail get_social_post_stats "HTTP $code"
rpc_json | py 'import sys,json;d=json.load(sys.stdin)
if d.get("error"): sys.exit("FAIL [get_social_post_stats] JSON-RPC error: "+json.dumps(d["error"])[:300])
r=d.get("result") or {}
if r.get("isError"): sys.exit("FAIL [get_social_post_stats] isError: "+json.dumps(r.get("content"),ensure_ascii=False)[:300])
txt="".join(c.get("text","") for c in r.get("content",[]))
print("OK   [get_social_post_stats] trả %d ký tự: %s"%(len(txt),txt[:160].replace("\n"," ")))' || fail get_social_post_stats "gọi tool"

echo "SMOKE MCP: ĐẠT"
