set -euo pipefail
cd /mnt/c/Users/HUAWEI/Desktop/xdepsisOS
B=http://127.0.0.1:3210
J=/tmp/probe-cookies
ID=$(python3 -c "
import io,json
d=json.load(io.open('/tmp/probe-list.json',encoding='utf-8'))
for it in d.get('items',[]):
    if it['name'].startswith('probe-') and it['size']==230: print(it['id']); break
")
echo "entry $ID"
curl -s -b $J "$B/api/v1/files/$ID/content" -o /tmp/probe-dl.jpg -w 'content %{http_code} %{size_download}\n'
python3 -c "
import io
b=io.open('/tmp/probe-dl.jpg','rb').read()
print('download length:', len(b))
print('matches source:', b == io.open('/tmp/probe-src.jpg','rb').read())
"
echo '--- agent log, last transfer lines ---'
grep -o '"operation":"open_download"[^}]*' /tmp/depsis-e2e/agent.log | tail -2 || true
