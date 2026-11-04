
import json, os, subprocess, sys, time, pathlib, threading
home=pathlib.Path(sys.argv[1]); exe=sys.argv[2]; cli=sys.argv[3]; ext=sys.argv[4]
env=os.environ.copy()
env.update({
 "PI_CODING_AGENT_DIR": str(home/"pi/agent"),
 "PI_CODING_AGENT_SESSION_DIR": str(home/"pi/sessions"),
 "SUPER_RLM_ORCHESTRATOR_URL": "http://127.0.0.1:18911",
 "SUPER_RLM_ROUTER_TOKEN": "spike-token",
})
p=subprocess.Popen([exe, cli, "--mode","rpc","--no-extensions","-e", ext,
                    "--no-skills","--no-context-files","--no-prompt-templates","--no-themes","--no-mcp","-nbt",
                    "--provider","fake","--model","fake-1","--session-dir",str(home/"pi/sessions"),"--session-id","super-rlm-router-sse-rpc"],
                   stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,text=True,encoding="utf-8",errors="replace",bufsize=1)
def reader():
    for line in p.stdout:
        try:
            o=json.loads(line)
        except Exception:
            print("RAW", line.rstrip()[:300], flush=True); continue
        t=o.get("type")
        if t in ("agent_start","agent_end","agent_settled","message_start","message_end","turn_start","turn_end"):
            s=json.dumps(o, ensure_ascii=False)
            print(t, s[:500], flush=True)
def ereader():
    for line in p.stderr:
        if line.strip(): print("ERR", line.rstrip()[:300], flush=True)
threading.Thread(target=reader,daemon=True).start(); threading.Thread(target=ereader,daemon=True).start()
cmd={"id":"p1","type":"prompt","message":"Create a hello file and report the result."}
p.stdin.write(json.dumps(cmd)+"\n"); p.stdin.flush()
time.sleep(15)
p.stdin.close()
try: p.wait(5)
except Exception: p.kill()
print("exit",p.returncode)
