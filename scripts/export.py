#!/usr/bin/env python3
"""微信文章批量导出：清单 -> 短链直抓 / 长链走微信 -> <entry_id>.html -> 清单。

清单 CSV 列：类型,entry_id,文章名称,链接（类型 = 长链/短链）。

用法:
  python3 export.py plan     --list LIST.csv --state work [--shortlinks a.jsonl ...] [--dead dead.jsonl ...]
  python3 export.py fetch    --state work --repo REPO [--workers 3]
  python3 export.py collect  --state work --shortlinks new.jsonl
  python3 export.py manifest --list LIST.csv --state work --repo REPO --name batch1
  python3 export.py status   --state work --repo REPO
"""
import argparse, csv, json, os, random, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')
BASE = {'Referer': 'https://mp.weixin.qq.com/', 'Accept-Language': 'zh-CN,zh;q=0.9', 'Accept-Encoding': 'identity'}


def load_list(path):
    with open(path, encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))
    out = []
    for r in rows:
        out.append({
            'type': (r.get('类型') or '').strip(),
            'id': (r.get('entry_id') or '').strip(),
            'title': (r.get('文章名称') or '').strip(),
            'link': (r.get('链接') or '').strip(),
        })
    return [r for r in out if r['id'] and r['link']]


def load_shortlinks(paths):
    m = {}
    for p in paths:
        if not p or not os.path.exists(p):
            continue
        for line in open(p):
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
                if o.get('id') and o.get('short'):
                    m[o['id']] = o['short']
            except Exception:
                pass
    return m


def load_ids(paths):
    s = set()
    for p in paths:
        if not p or not os.path.exists(p):
            continue
        for line in open(p):
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
                if o.get('id'):
                    s.add(o['id'])
            except Exception:
                pass
    return s


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, **BASE})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read()


def valid_html(h):
    return ('id="js_content"' in h) or ('content_noencode' in h)


def classify(data):
    """返回 (status, kind)。kind: js / pic / None"""
    h = data.decode('utf-8', 'ignore')
    if '该内容已被发布者删除' in h:
        return 'dead', None
    if '此账号已自主注销' in h:
        return 'cancelled', None
    if len(data) < 200000:
        return 'small', None
    if 'id="js_content"' in h:
        return 'ok', 'js'
    if 'content_noencode' in h:
        return 'ok', 'pic'
    return 'no_content', None


def fetch_one(row, short, dst, tries=5):
    for k in range(tries):
        try:
            data = get(short)
            st, kind = classify(data)
            if st == 'small':
                time.sleep(6 * (k + 1) + random.random() * 3)
                continue
            if st == 'ok':
                with open(dst, 'wb') as f:
                    f.write(data)
                time.sleep(0.3)
                return {'status': 'ok', 'kind': kind, 'bytes': len(data)}
            return {'status': st, 'kind': None, 'bytes': len(data)}
        except Exception as e:
            if k == tries - 1:
                return {'status': 'blocked', 'kind': None, 'error': str(e)[:80]}
            time.sleep(5 * (k + 1))
    return {'status': 'blocked', 'kind': None}


def p_state(a):
    os.makedirs(a.state, exist_ok=True)
    rows = load_list(a.list)
    shorts = load_shortlinks(a.shortlinks or [])
    dead = load_ids(a.dead or [])
    plan = {'list': os.path.abspath(a.list), 'rows': rows, 'dead': sorted(dead)}
    json.dump(plan, open(os.path.join(a.state, 'plan.json'), 'w'), ensure_ascii=False, indent=1)
    json.dump(shorts, open(os.path.join(a.state, 'shorts.json'), 'w'), ensure_ascii=False, indent=1)
    status = {}
    sp = os.path.join(a.state, 'status.json')
    if os.path.exists(sp):
        status = json.load(open(sp))
    html_dir = os.path.join(a.repo, 'html')
    have = sum(1 for r in rows if os.path.exists(os.path.join(html_dir, r['id'] + '.html')))
    need_wx = [r for r in rows if r['id'] not in shorts and r['id'] not in dead
               and not os.path.exists(os.path.join(html_dir, r['id'] + '.html'))]
    direct = [r for r in rows if r['id'] in shorts and not os.path.exists(os.path.join(html_dir, r['id'] + '.html'))]
    with open(os.path.join(a.state, 'wechat-table.txt'), 'w') as f:
        for i, r in enumerate(need_wx, 1):
            f.write('%d|%s|%s|%s\n' % (i, r['id'], r['title'].replace('|', '／'), r['link']))
    print(f'清单 {len(rows)} 条：已有 html {have}，可直接抓 {len(direct)}，需微信 {len(need_wx)}，已确认死链 {len([r for r in rows if r["id"] in dead])}')
    print(f'微信表：{os.path.join(a.state, "wechat-table.txt")}')


def p_fetch(a):
    plan = json.load(open(os.path.join(a.state, 'plan.json')))
    shorts = json.load(open(os.path.join(a.state, 'shorts.json')))
    sp = os.path.join(a.state, 'status.json')
    status = json.load(open(sp)) if os.path.exists(sp) else {}
    html_dir = os.path.join(a.repo, 'html')
    os.makedirs(html_dir, exist_ok=True)
    todo = [r for r in plan['rows'] if r['id'] in shorts
            and not os.path.exists(os.path.join(html_dir, r['id'] + '.html'))]
    print(f'待抓 {len(todo)}')
    done = 0

    def work(r):
        dst = os.path.join(html_dir, r['id'] + '.html')
        res = fetch_one(r, shorts[r['id']], dst)
        return r['id'], res

    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        for eid, res in ex.map(work, todo):
            status[eid] = res
            done += 1
            if done % 20 == 0 or res['status'] != 'ok':
                print(f'{done}/{len(todo)} {eid[:8]} {res["status"]}', flush=True)
            if done % 20 == 0:
                json.dump(status, open(sp, 'w'), ensure_ascii=False)
    json.dump(status, open(sp, 'w'), ensure_ascii=False)
    from collections import Counter
    print(Counter(v['status'] for v in status.values()))


def p_collect(a):
    sp = os.path.join(a.state, 'shorts.json')
    shorts = json.load(open(sp)) if os.path.exists(sp) else {}
    new = load_shortlinks(a.shortlinks or [])
    shorts.update(new)
    json.dump(shorts, open(sp, 'w'), ensure_ascii=False, indent=1)
    print(f'合并短链 {len(new)} 条，共 {len(shorts)} 条')


def p_manifest(a):
    plan = json.load(open(os.path.join(a.state, 'plan.json')))
    sp = os.path.join(a.state, 'status.json')
    status = json.load(open(sp)) if os.path.exists(sp) else {}
    dead = set(plan.get('dead', []))
    html_dir = os.path.join(a.repo, 'html')
    out = []
    counts = {}
    for r in plan['rows']:
        fn = r['id'] + '.html'
        p = os.path.join(html_dir, fn)
        if os.path.exists(p):
            h = open(p, encoding='utf-8', errors='ignore').read(3000000)
            st = 'ok' if 'id="js_content"' in h else ('ok（小绿书 content_noencode）' if 'content_noencode' in h else 'ok')
        else:
            s = (status.get(r['id']) or {}).get('status')
            if s == 'dead':
                st = 'dead（已删除）'
            elif s == 'cancelled':
                st = 'dead（账号已注销）'
            elif s == 'no_content':
                st = 'no_content（需微信内打开）'
            elif s == 'blocked':
                st = 'blocked（重试耗尽）'
            elif r['id'] in dead:
                st = 'dead（已确认删除）'
            else:
                st = '未获取'
        counts[st] = counts.get(st, 0) + 1
        out.append([r['id'], r['type'], r['title'], r['link'], st, fn if os.path.exists(p) else ''])
    name = a.name or 'batch'
    mp = os.path.join(html_dir, f'_manifest-{name}.csv')
    with open(mp, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f)
        w.writerow(['entry_id', '类型', '文章名称', '链接', '状态', '文件'])
        w.writerows(out)
    print(counts, '有文件', sum(1 for x in out if x[5]))
    print('清单:', mp)


def p_status(a):
    plan = json.load(open(os.path.join(a.state, 'plan.json')))
    sp = os.path.join(a.state, 'status.json')
    status = json.load(open(sp)) if os.path.exists(sp) else {}
    html_dir = os.path.join(a.repo, 'html')
    have = sum(1 for r in plan['rows'] if os.path.exists(os.path.join(html_dir, r['id'] + '.html')))
    from collections import Counter
    c = Counter((status.get(r['id']) or {}).get('status', 'pending') for r in plan['rows'])
    print(f'清单 {len(plan["rows"])}，已有 html {have}，状态 {dict(c)}')


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name in ('plan', 'fetch', 'collect', 'manifest', 'status'):
        p = sub.add_parser(name)
        p.add_argument('--state', required=True)
        if name in ('plan', 'manifest'):
            p.add_argument('--list', required=True)
            p.add_argument('--repo', required=name == 'manifest')
            p.add_argument('--name')
            p.add_argument('--shortlinks', nargs='*')
            p.add_argument('--dead', nargs='*')
        elif name in ('fetch', 'status'):
            p.add_argument('--repo', required=True)
            if name == 'fetch':
                p.add_argument('--workers', type=int, default=3)
        elif name == 'collect':
            p.add_argument('--shortlinks', nargs='*', required=True)
    a = ap.parse_args()
    {'plan': p_state, 'fetch': p_fetch, 'collect': p_collect,
     'manifest': p_manifest, 'status': p_status}[a.cmd](a)


if __name__ == '__main__':
    main()
