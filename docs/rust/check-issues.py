#!/usr/bin/env python3
"""Kiểm đồ thị phụ thuộc của docs/rust/ISSUES.md: trùng ID, tham chiếu thiếu, vòng, đường găng.
Chạy trong thư mục docs/rust:  python3 check-issues.py   (mọi issue M.. ngầm phụ thuộc K14, K15)"""
import re,sys,collections
s=open('ISSUES.md',encoding='utf-8').read()
rows=[[x.strip() for x in l.strip().strip('|').split('|')] for l in s.splitlines() if re.match(r'^\| [A-Z]\d',l)]
ids=[r[0] for r in rows]; idx={i:n for n,i in enumerate(ids)}; w={'S':.5,'M':1,'L':2}
size={r[0]:w[r[6]] for r in rows}; deps={}; bad=[]
for r in rows:
    d=set(); txt=r[3]
    for a,b in re.findall(r'([A-Z]\d{2,3}[a-f]?)–([A-Z]\d{2,3}[a-f]?)',txt):
        if a not in idx or b not in idx: bad.append((r[0],a+'–'+b)); continue
        pre=re.match(r'[A-Z]+',a).group()
        d.update(i for i in ids[idx[a]:idx[b]+1] if re.match(r'[A-Z]+',i).group()==pre)
    txt2=re.sub(r'[A-Z]\d{2,3}[a-f]?–[A-Z]\d{2,3}[a-f]?','',txt)
    for m in re.findall(r'[A-Z]\d{2,3}[a-f]?',txt2):
        if m not in idx: bad.append((r[0],m))
        else: d.add(m)
    if r[0][0]=='M': d.update({'K14','K15'})
    d.discard(r[0]); deps[r[0]]=d
# cycles (Kahn)
indeg={i:len(deps[i]) for i in ids}; rev=collections.defaultdict(set)
for i in ids:
    for d in deps[i]: rev[d].add(i)
q=[i for i in ids if indeg[i]==0]; order=[]
while q:
    x=q.pop(); order.append(x)
    for y in rev[x]:
        indeg[y]-=1
        if indeg[y]==0: q.append(y)
cyc=[i for i in ids if i not in order]
c=collections.Counter(r[6] for r in rows)
print(f"issues={len(ids)} S={c['S']} M={c['M']} L={c['L']} days={sum(size.values())} dup={len(ids)-len(set(ids))} missing={bad} cycle_nodes={cyc}")
if not cyc:
    best={}; prev={}
    for x in order:
        b=max(deps[x],key=lambda d:best[d],default=None)
        best[x]=size[x]+(best[b] if b else 0); prev[x]=b
    end=max(best,key=best.get); path=[]
    while end: path.append(end); end=prev[end]
    print('critical',' → '.join(reversed(path)),max(best.values()))
    for t in ['D01','C06a','X02a','X02e','W02b','W03','X06','X15a']:
        if t in best:
            p=[];e=t
            while e: p.append(e); e=prev[e]
            print(t,best[t],' → '.join(reversed(p)))
ph=collections.defaultdict(float)
for i in ids: ph[re.match(r'[A-Z]+',i).group()]+=size[i]
print(dict(ph))
