#!/usr/bin/env bash
# 一键部署：本地检查 → 上传代码 → 服务器上构建并重启 → 冒烟测试（只测离线回放，不花模型费用）。
# 用法：npm run deploy        换服务器：DEPLOY_HOST=ubuntu@1.2.3.4 npm run deploy
set -euo pipefail

HOST="${DEPLOY_HOST:-ubuntu@43.143.61.204}"
DIR=/opt/yield-agent
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️  有未提交的改动，也会一起部署上去"
fi

echo "▶ 本地类型检查和 lint"
npx tsc --noEmit
npm run lint --silent

echo "▶ 上传代码到 $HOST:$DIR"
rsync -az --delete --exclude node_modules --exclude .next --exclude .env.local --exclude .git --exclude .DS_Store --exclude tsconfig.tsbuildinfo ./ "$HOST:$DIR/"

echo "▶ 服务器上安装依赖、构建、重启"
ssh "$HOST" "cd $DIR && npm ci --no-audit --no-fund && npm run build && pm2 restart yield-agent --update-env"

echo "▶ 冒烟测试"
URL="http://${HOST#*@}"
sleep 3
code=$(curl -s -o /dev/null -w "%{http_code}" "$URL/")
[ "$code" = 200 ] || { echo "❌ 首页返回 $code，看日志：ssh $HOST pm2 logs yield-agent"; exit 1; }
curl -sN -m 60 "$URL/api/agent" -H 'content-type: application/json' \
  -d '{"prompt":"N3B412 中心区域漏电多，查一下是哪道工序"}' | grep -q '"type":"done"' \
  || { echo "❌ 离线回放没有跑完，看日志：ssh $HOST pm2 logs yield-agent"; exit 1; }
echo "✅ 部署完成：$URL  （在线模型：$(curl -s "$URL/api/agent")）"
