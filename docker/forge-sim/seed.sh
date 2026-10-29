#!/usr/bin/env bash
# Seed the local GitLab with throwaway accounts: users alice and bob, a group
# `sandbox` both maintain, and an API token per user in .tokens/<user>.
# Idempotent: rerunning keeps what exists. The accounts are fake and worthless.
set -euo pipefail
cd "$(dirname "$0")"
URL=http://localhost:8929
ROOT_TOKEN=forge-sim-root-token-00001
PROJECT=linkr-forge-sim

echo "Waiting for GitLab to answer…"
until curl -sf -o /dev/null "$URL/users/sign_in"; do sleep 5; done

# A root API token, set through the Rails console (the API cannot mint the first one).
docker compose -p "$PROJECT" exec -T gitlab gitlab-rails runner "
  u = User.find_by_username('root')
  unless u.personal_access_tokens.active.find_by(name: 'forge-sim')
    t = u.personal_access_tokens.create!(scopes: ['api', 'admin_mode'], name: 'forge-sim', expires_at: 365.days.from_now)
    t.set_token('$ROOT_TOKEN'); t.save!
  end
  ApplicationSetting.current.update!(signup_enabled: false)
" >/dev/null

api() { curl -sf -H "PRIVATE-TOKEN: $ROOT_TOKEN" -H 'Content-Type: application/json' "$@"; }
mkdir -p .tokens

group_id=$(api "$URL/api/v4/groups?search=sandbox" | python3 -c 'import sys,json;g=[x for x in json.load(sys.stdin) if x["path"]=="sandbox"];print(g[0]["id"] if g else "")')
[ -n "$group_id" ] || group_id=$(api -X POST "$URL/api/v4/groups" -d '{"name":"sandbox","path":"sandbox","visibility":"private"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

for user in alice bob; do
  uid=$(api "$URL/api/v4/users?username=$user" | python3 -c 'import sys,json;u=json.load(sys.stdin);print(u[0]["id"] if u else "")')
  [ -n "$uid" ] || uid=$(api -X POST "$URL/api/v4/users" -d "{\"username\":\"$user\",\"name\":\"$user\",\"email\":\"$user@forge-sim.local\",\"password\":\"$(openssl rand -base64 18)Aa1!\",\"skip_confirmation\":true}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  api -X POST "$URL/api/v4/groups/$group_id/members" -d "{\"user_id\":$uid,\"access_level\":40}" >/dev/null 2>&1 || true
  if [ ! -s ".tokens/$user" ]; then
    api -X POST "$URL/api/v4/users/$uid/personal_access_tokens" -d "{\"name\":\"linkr\",\"scopes\":[\"api\",\"write_repository\"],\"expires_at\":\"$(date -v+1y +%F 2>/dev/null || date -d '+1 year' +%F)\"}" \
      | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])' > ".tokens/$user"
  fi
  echo "$user: id $uid, token in docker/forge-sim/.tokens/$user"
done
echo "Group sandbox: $URL/sandbox (id $group_id)"
