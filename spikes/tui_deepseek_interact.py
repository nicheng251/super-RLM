
import os, re, threading, time, pathlib, sys
from winpty import PtyProcess
home=pathlib.Path(sys.argv[1]); node=sys.argv[2]; cli=sys.argv[3]; router_dir=pathlib.Path(sys.argv[4]); out=pathlib.Path(sys.argv[5])
env=dict(os.environ); env.update({"PI_CODING_AGENT_DIR":str(home/"pi/agent"),"PI_CODING_AGENT_SESSION_DIR":str(home/"pi/sessions"),"SUPER_RLM_HOME":str(home),"SUPER_RLM_ORCHESTRATOR_URL":"http://127.0.0.1:18796","SUPER_RLM_ROUTER_TOKEN":"dev-router-token","TERM":"xterm-256color","COLORTERM":"truecolor"})
args=[node,cli,"-na","--no-extensions","-e",str(router_dir/"extensions"/"super-rlm.ts"),"--no-skills","--no-context-files","--no-prompt-templates","--no-themes","--no-mcp","-nbt","--provider","deepseek","--model","deepseek-flash","--session-dir",str(home/"pi/sessions"),"--session-id","super-rlm-router-tui-ds5"]
p=PtyProcess.spawn(args,cwd=str(router_dir),env=env,dimensions=(45,130))
buf=[]
def reader():
    while True:
        try:
            d=p.read(65536)
            if d: buf.append(d)
        except Exception as e:
            buf.append(f"\n<<READER:{type(e).__name__}>>"); return
threading.Thread(target=reader,daemon=True).start()
def strip(t):
    t=re.sub(r"\x1b\][^\x07]*\x07","",t)
    t=re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]","",t)
    t=re.sub(r"\x1b[()][A-Z0-9]","",t)
    return t.replace("\r","")
snaps=[]
def snap(label):
    s=strip("".join(buf)); snaps.append((label,s)); return s
def waitfor(needle, timeout, label, key=None):
    end=time.time()+timeout
    while time.time()<end:
        s=snap(label)
        if needle in s: return s
        if key: p.write(key)
        time.sleep(2)
    return snap(label)

time.sleep(10)
p.write("/tasks\r"); time.sleep(5); s1=snap("tasks")
p.write("\r"); time.sleep(5); s2=snap("detail")
p.write("a"); time.sleep(2); s3=snap("answer-prompt")
p.write("Linux\r"); time.sleep(20); s4=snap("after-answer")
s5=waitfor("succeeded", 40, "after-refresh", "r")
p.write("q"); time.sleep(1); p.write("\x03"); time.sleep(1)
try: p.terminate()
except: pass
out.write_text("\n\n".join(f"===== {label} =====\n{text}" for label,text in snaps),encoding="utf-8")
def has(s, needle): return needle in s
print("tasks", has(s1,"Tasks"), has(s1,"tsk_18d0a468482e4f5191c5"))
print("detail", has(s2,"Task tsk_18d0a468482e4f5191c5"), has(s2,"Linux or Windows?"), has(s2,"first ticket"))
print("answer prompt", has(s3,"Answer"), has(s3,"Linux or Windows?"))
print("after answer", has(s4,"succeeded"), has(s4,"chose") or has(s4,"Linux"))
print("final", has(s5,"succeeded"), has(s5,"chose") or has(s5,"Linux"))
print("final tail ascii:\n", s5[-2000:].encode("ascii","replace").decode("ascii"))
