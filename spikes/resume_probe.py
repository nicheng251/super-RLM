
import json, os, subprocess, sys, threading, time, pathlib
home=pathlib.Path(sys.argv[1]); exe=sys.argv[2]
sessdir=home/"prime/sessions"/"resume_test"; sessdir.mkdir(parents=True, exist_ok=True)
work=home/"workspaces"/"tkt_spike_resume"; work.mkdir(parents=True, exist_ok=True)

def run(resume_file=None, text="Remember the word PINEAPPLE.", sock="prime9.sock", sid_timeout=20):
    env=os.environ.copy()
    env["PRIME_AGENT_CODING_AGENT_DIR"]=str(home/"prime/agent")
    env["PRIME_AGENT_SESSION_DIR"]=str(sessdir)
    env["PRIME_AGENT_DAEMON_SOCKET"]=str(home/"prime/daemon"/sock)
    env["PRIME_AGENT_KERNEL_VENV"]=str(home/"prime/kernel-venv")
    env["PRIME_AGENT_KERNEL_PYTHON"]=str(home/"prime/kernel-venv/Scripts/python.exe")
    args=[exe,"--mode","acp","--cwd",str(work),"--provider","fake","--model","fake-1","--session-dir",str(sessdir),"--daemon-socket",str(home/"prime/daemon"/sock)]
    if resume_file: args += ["--resume", str(resume_file)]
    p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,text=True,encoding="utf-8",errors="replace",bufsize=1)
    SID=None
    def reader():
        nonlocal SID
        for line in p.stdout:
            print("OUT",line.rstrip(),flush=True)
            try:
                o=json.loads(line)
                if o.get("id")==2: SID=o["result"]["sessionId"]
            except Exception: pass
    def ereader():
        for line in p.stderr: print("ERR",line.rstrip().encode("utf-8","replace").decode("utf-8"),flush=True)
    threading.Thread(target=reader,daemon=True).start(); threading.Thread(target=ereader,daemon=True).start()
    def send(o):
        print("SEND",json.dumps(o),flush=True); p.stdin.write(json.dumps(o)+"\n"); p.stdin.flush()
    send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":True,"writeTextFile":True},"terminal":True},"clientInfo":{"name":"probe","version":"0.1"}}})
    time.sleep(1.5)
    send({"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":str(work),"mcpServers":[]}})
    time.sleep(1.5)
    send({"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":SID,"prompt":[{"type":"text","text":text}]}})
    time.sleep(8)
    p.terminate()
    try: p.wait(5)
    except Exception: p.kill()
    return SID

print("=== FIRST ===")
run()
files=sorted(sessdir.glob("*.jsonl"))
print("FILES",[str(f) for f in files],flush=True)
if files:
    print("=== SECOND (resume) ===")
    run(resume_file=files[-1], text="What word did I ask you to remember?", sock="prime9.sock")
print("=== FILES AFTER ===")
print([str(f) for f in sorted(sessdir.glob("*.jsonl"))],flush=True)
