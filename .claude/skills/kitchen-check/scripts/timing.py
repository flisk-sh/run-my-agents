import json,glob,os,sys,datetime
tasks={t['n']:t for t in json.load(open(os.path.expanduser('~/.run-my-agents/tasks.json')))}
def ts(s):
    return datetime.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
for n in [int(a) for a in sys.argv[1:]]:
    t=tasks.get(n)
    if not t: continue
    files=glob.glob(os.path.expanduser(f'~/.claude/projects/*kitchen-order-{n}/*.jsonl'))
    turns=[]
    for f in files:
        ev=[json.loads(l) for l in open(f) if l.strip()]
        ev=[e for e in ev if e.get('timestamp') and e.get('type') in('user','assistant')]
        if not ev: continue
        # split into turns: a user message with string content (prompt) starts a turn
        cur=None
        for e in ev:
            m=e.get('message',{});c=m.get('content')
            isprompt=e['type']=='user' and (isinstance(c,str) or (isinstance(c,list) and c and c[0].get('type')=='text'))
            if isprompt:
                txt=c if isinstance(c,str) else c[0].get('text','')
                cur={'start':ts(e['timestamp']),'end':ts(e['timestamp']),'prompt':txt[:60].replace('\n',' '),'last':''}
                turns.append(cur)
            elif cur:
                cur['end']=ts(e['timestamp'])
                if e['type']=='assistant':
                    for b in (c or []):
                        if isinstance(b,dict) and b.get('type')=='text': cur['last']=b['text'][-90:].replace('\n',' ')
    turns.sort(key=lambda x:x['start'])
    t0=t['created']/1000
    print(f"#{n} created {datetime.datetime.fromtimestamp(t0):%H:%M:%S} served {datetime.datetime.fromtimestamp((t.get('servedAt') or 0)/1000):%H:%M:%S} total {((t.get('servedAt') or 0)/1000-t0)/60:.1f}m")
    prev=t0
    for x in turns:
        print(f"   gap {x['start']-prev:6.0f}s | work {x['end']-x['start']:5.0f}s | {x['prompt'][:48]:48} | ends: {x['last'][-60:]}")
        prev=x['end']
    print(f"   gap to served {(t.get('servedAt') or 0)/1000-prev:6.0f}s")
