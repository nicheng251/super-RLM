
import json, os, subprocess, sys, threading, time, pathlib
home=pathlib.Path(sys.argv[1]); exe=sys.argv[2]; skill=sys.argv[3]
work=home/"workspaces"/"tkt_spike_enforce"; work.mkdir(parents=True,exist_ok=True)
sock=home/"prime/daemon/enforce1.sock"
env=os.environ.copy()
env["PRIME_AGENT_CODING_AGENT_DIR"]=str(home/"prime/agent")
env["PRIME_AGENT_SESSION_DIR"]=str(home/"prime/sessions"/"enforce")
env["PRIME_AGENT_DAEMON_SOCKET"]=str(sock)
env["PRIME_AGENT_KERNEL_VENV"]=str(home/"prime/kernel-venv")
env["PRIME_AGENT_KERNEL_PYTHON"]=str(home/"prime/kernel-venv/Scripts/python.exe")
env["SUPER_RLM_REPORT_URL"]="http://127.0.0.1:18903/report"
env["SUPER_RLM_REPORT_TOKEN"]="report-token"
p=subprocess.Popen([exe,"--mode","acp","--cwd",str(work),"--provider","fake","--model","fake-1",
                    "--session-dir",str(home/"prime/sessions"/"enforce"),"--daemon-socket",str(sock),
                    "--skill",str(skill),"-ns","--no-context-files"],
                   stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,text=True,encoding="utf-8",errors="replace",bufsize=1)
SID=None
def reader():
    global SID
    for line in p.stdout:
        print("OUT",line.rstrip(),flush=True)
        try:
            o=json.loads(line)
            if o.get("id")==2: SID=o["result"]["sessionId"]
        except Exception: pass
def ereader():
    for line in p.stderr: print("ERR",line.rstrip(),flush=True)
threading.Thread(target=reader,daemon=True).start(); threading.Thread(target=ereader,daemon=True).start()
def send(o):
    print("SEND",json.dumps(o),flush=True); p.stdin.write(json.dumps(o)+"\n"); p.stdin.flush()
send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":True,"writeTextFile":True},"terminal":True},"clientInfo":{"name":"probe","version":"0.1"}}})
time.sleep(1.5)
send({"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":str(work),"mcpServers":[]}})
time.sleep(1.5)
send({"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":SID,"prompt":[{"type":"text","text":"Do the task."}]}})
time.sleep(8)
send({"jsonrpc":"2.0","id":4,"method":"session/prompt","params":{"sessionId":SID,"prompt":[{"type":"text","text":"Before ending, call super_rlm_report with the terminal state."}]}})
time.sleep(10)
p.terminate()
try: p.wait(5)
except Exception: p.kill()
print("exit",p.returncode)
