///<reference path='../typings/node/node.d.ts'/>

import fs = require('fs');

var fileLog: (msg: string) => void = undefined;
if (process.env["TD_SHELL_LOG_FILE"]) {
    var logPath = process.env["TD_SHELL_LOG_FILE"];
    fileLog = (msg) => {
        var fl = fs.openSync(logPath, "a");
        var b = new Buffer(msg + '\r\n');
        fs.writeSync(fl, b, 0, b.length, 0);
        fs.closeSync(fl);
    }
}

import url = require('url');
import http = require('http');
import https = require('https');
import path = require('path');
import zlib = require('zlib');
import util = require('util');
import crypto = require('crypto');
import child_process = require('child_process');
import os = require('os');
import events = require('events');
import net = require("net");
import tls = require("tls");

var config: any;
var currentReqNo = 0;
var inAzure = false;
var trustXff = false;
var isNpm = false;
var inNodeWebkit = false;
var dataDir: string = ".";
var useFileSockets = false;
var numWorkers = 1;
var blobChannel = "";
var restartInterval = 0;
var numResponses = 0;
var pfx = null
var domainContexts = {}
var defaultContext: any

function dataPath(p: string): string {
    p = p || "";
    return dataDir ? path.join(dataDir, p) : p;
}

interface TdState {
    downloadedFiles: StringMap<string>;
    numDeploys: number;
    deployedId: string;
    dmeta: any;
}

var tdstate: TdState;

interface LogMessage {
    timestamp: number;
    msg: string;
}

class Logger {
    logIdx = -1;
    logMsgs: LogMessage[] = [];
    logSz = 1000;

    constructor(public name: string, public level: number)
    { }

    addMsg(s: string) {
        var m = {
            timestamp: Date.now(),
            msg: s
        }
        if (fileLog) fileLog(s);
        if (!inAzure) console.log(s)
        if (this.logIdx >= 0) {
            this.logMsgs[this.logIdx++] = m;
            if (this.logIdx >= this.logSz) this.logIdx = 0;
        } else {
            this.logMsgs.push(m);
            if (this.logMsgs.length >= this.logSz)
                this.logIdx = 0;
        }
    }

    log(...args: any[]) {
        this.addMsg(util.format.apply(null, args))
    }

    getMsgs(): any[] {
        var i = this.logIdx;
        var res = [];
        var wrapped = false;
        if (i < 0) i = 0;
        var n = Date.now()
        while (i < this.logMsgs.length) {
            var m = this.logMsgs[i]
            var diff = ("00000000" + (n - m.timestamp)).slice(-7).replace(/(\d\d\d)$/, (m) => "." + m);
            res.push({
                timestamp: m.timestamp,
                msg: m.msg,
                elapsed: diff,
                level: this.level,
                category: "shell",
            })
            if (++i == this.logMsgs.length && !wrapped) {
                wrapped = true;
                i = 0;
            }
            if (wrapped && i >= this.logIdx) break;
        }
        res.reverse()
        return res;
    }
}

var error = new Logger("error", 3)
var info = new Logger("info", 6)
var debug = new Logger("debug", 7)

class ApiRequest {
    data: any = {}
    cmd: string[] = [];
    reqNo = ++currentReqNo;
    encrypted = false;
    respStream = null;

    constructor(public req: http.ServerRequest, public resp: http.ServerResponse) {
        this.respStream = this.resp;
    }

    forwardToWorkers() {
        var respArr = []
        var numReqs = 1

        var oneUp = () => {
            if (--numReqs == 0) this.ok({ workers: respArr })
        }

        workers.forEach((w, i) => {
            var thisResp: any = {
                worker: w.description(),
            }
            respArr[i] = thisResp

            if (!w.child) {
                thisResp.code = -1
                return
            }

            var u = w.getUrl()
            u.method = this.req.method
            u.headers = {} // no headers
            u.path = this.req.url

            numReqs++
            var creq = http.request(u, cres => {
                thisResp.code = cres.statusCode
                cres.setEncoding("utf8")
                var s = ""
                cres.on("data", d => s += d)
                cres.on("end", () => {
                    try {
                        thisResp.body = JSON.parse(s)
                    } catch (e) {
                        thisResp.body = s
                    }
                    oneUp()
                })
            })
            creq.on("error", err => {
                thisResp.code = -1
                thisResp.body = err.message || (err + "")
                oneUp()
            })
            if (Object.keys(this.data).length > 0)
                creq.end(JSON.stringify(this.data))
            else creq.end()
        })
        oneUp()
    }

    error(code: number, text: string) {
        info.log("HTTP error " + code + ": " + text)
        this.resp.writeHead(code, { 'Content-Type': 'text/plain' })
        this.respStream.write(text, "utf8")
        this.respStream.end()
    }

    setCors() {
        this.resp.setHeader('Access-Control-Allow-Origin', "*");
        this.resp.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST');
        this.resp.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        this.resp.setHeader('Access-Control-Expose-Headers', 'ErrorMessage');
    }

    processMgmt() {
        var cmd = this.cmd
        if (this.data.minVersion && config.shellVersion < this.data.minVersion) {
            this.error(400, "shell version is too old")
            return
        }
        if (mgmt.hasOwnProperty(cmd[0])) {
            mgmt[cmd[0]](this);
        } else {
            this.error(404, "no such api " + cmd[0])
        }
    }

    forwardToOneWorker() {
        var w = pickWorker()
        var u = w.getUrl()
        u.method = this.data.method || "GET"
        u.headers = {} // no headers
        u.path = this.data.url

        var creq = http.request(u, cres => {
            readRes(cres, total => {
                this.ok({
                    resp: total.toString("utf8"),
                    headers: cres.headers,
                    code: cres.statusCode
                })
            })
        })
        creq.on("error", err => {
            this.ok({
                code: 600,
                resp: err.message || (err + "")
            })
        })
        if (typeof this.data.body == "string")
            creq.end(this.data.body)
        else if (typeof this.data == "object")
            creq.end(JSON.stringify(this.data.body))
        else creq.end()
    }

    handleEncryptedMgmt() {
        var stream = decipherReq(this.req)
        if (stream == this.req)
            this.error(403, "Not encrypted")

        var g = zlib.createGunzip(undefined);
        (<any>stream).pipe(g);
        readRes(g, total => {
            var op = JSON.parse(total.toString("utf8"))
            // make sure this is somewhat long string
            if (op.op == "ShellMgmtCommand") {
                this.encrypted = true;
                this.respStream = cipherResp(this.resp);
                this.cmd = op.cmd
                this.data = op.data
                if (this.cmd[0] == "worker") {
                    this.forwardToOneWorker();
                } else {
                    this.processMgmt()
                }
            } else {
                this.error(403, "bad op")
            }
        })
    }

    handleMgmt(cmd: string[]) {
        var buf = ""

        var final = () => {
            try {
                this.cmd = cmd;
                this.data = JSON.parse(buf || "{}")
                this.processMgmt()
            } catch (e) {
                this.exception(e)
            }
        }

        var req = this.req
        if (req.method == "POST" || req.method == "PUT") {
            /*
            var stream = decipherReq(req)
            this.encrypted = (stream != req)
            if (this.encrypted)
                this.respStream = cipherResp(this.resp);
            */

            var stream = <any>req
            if (/gzip/.test(req.headers['content-encoding'])) {
                var g = zlib.createGunzip(undefined);
                stream.pipe(g);
                stream = g;
            }
            readRes(stream, total => {
                buf = total.toString("utf8")
                final()
            })
        } else {
            final()
        }
    }

    ok(r: any) {
        var buf = new Buffer(JSON.stringify(r), "utf8")
        var hd: any = { 'Content-Type': 'application/json; encoding=utf-8' }
        var zl: any = zlib;
        if (zl.gzipSync && /gzip/.test(this.req.headers['accept-encoding'])) {
            buf = zl.gzipSync(buf);
            hd['Content-Encoding'] = this.encrypted ? 'x-td-encgz' : 'gzip';
        }
        this.resp.writeHead(200, hd)
        this.respStream.write(buf)
        this.respStream.end()
    }

    exception(e: any) {
        saveState()
        var msg = "exception: " + e.toString() + " " + e.stack
        error.log(msg)
        this.error(500, msg) // TODO remove
    }

    pluginCb(passData = false) {
        return (err, data) => {
            if (err) this.ok({ error: err + "" })
            else if (passData)
                this.ok({ data: data })
            else
                this.ok({})
        }
    }
}

function readRes(g, f) {
    var bufs = []
    g.on('data', (c) => {
        if (typeof c === "string")
            bufs.push(new Buffer(c, "utf8"))
        else
            bufs.push(c)
    });

    g.on('end', () => {
        var total = Buffer.concat(bufs)
        f(total)
    })
}

function downloadFile(u: string, f: (err: any, s: NodeBuffer, h?: any) => void) {
    var p: any = url.parse(u);

    p.headers = {
        "Accept-Encoding": "gzip"
    }

    var mod: any = http
    if (p.protocol == "https:")
        mod = https

    debug.log('download ' + u);
    mod.get(p, (res: http.ClientResponse) => {
        if (res.statusCode == 302) {
            downloadFile(res.headers['location'], f);
            (<any>res).end();
        } else if (res.statusCode == 200) {
            if (/gzip/.test(res.headers['content-encoding'])) {
                var g: events.EventEmitter = zlib.createUnzip(undefined);
                (<any>res).pipe(g);
            } else {
                g = res;
                // (<any>res).setEncoding('utf8');
            }

            readRes(g, total => {
                f(null, total, (<any>res).headers)
            })

        } else {
            var msg = "error downloading file " + u + "; HTTP " + res.statusCode
            error.log(msg)
            f(msg, null)
        }
    }).on("error", e => {
        var msg = "error downloading file " + u + "; " + e
        error.log(msg)
        f(msg, null)
    })
}

var vaultToken = ""
var vaultClientId = ""
var vaultSecret = ""
var vaultUrl = ""
var numRetries = 0

function downloadSecret(uri: string, f: (d: any) => void, opts: any = {}) {
    var p: any = url.parse(uri + "?api-version=2015-06-01")
    p.headers = {}
    if (vaultToken)
        p.headers['Authorization'] = 'Bearer ' + vaultToken
    if (opts.put) {
        p.method = 'PUT'
        var data = new Buffer(JSON.stringify(opts.put), "utf8")
        p.headers['Content-Length'] = data.length
        p.headers['Content-Type'] = "application/json;charset=utf8"
    }
    debug.log("vault: downloading secret from " + uri)
    var r = https.request(p, (res: http.ClientResponse) => {
        if (res.statusCode == 401) {
            if (numRetries > 3) {
                error.log("too many retries")
                return
                //process.exit(1)
            }
            var m = /authorization="([^"]+)".*resource="([^"]+)"/.exec(res.headers['www-authenticate'])
            if (!m) {
                error.log("bad auth header, " + JSON.stringify(res.headers))
                return
                //process.exit(1)
            }

            var d = "grant_type=client_credentials" +
                "&client_id=" + encodeURIComponent(vaultClientId) +
                "&client_secret=" + encodeURIComponent(vaultSecret) +
                "&resource=" + encodeURIComponent(m[2]);
            var pp: any = url.parse(m[1] + "/oauth2/token")
            pp.headers = {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
            pp.method = 'POST';
            var r = https.request(pp, (res: http.ClientResponse) => {
                readRes(res, total => {
                    if (res.statusCode != 200) {
                        error.log("get token failed for " + uri)
                        error.log(total.toString("utf8"))
                        return
                    }
                    var j = JSON.parse(total.toString("utf8"))
                    vaultToken = j.access_token
                    numRetries++
                    downloadSecret(uri, f, opts)
                })
            })
            r.end(d)
        } else {
            numRetries = 0
            readRes(res, total => {
                if (res.statusCode != 200) {
                    error.log("get failed for " + uri)
                    error.log(total.toString("utf8"))
                    return
                } else {
                    var d = JSON.parse(total.toString("utf8"))
                    debug.log("vault: got secret, " + (d && d.value ? d.value.length : "<nil>"))
                    f(d)
                }
            })
        }
    })

    r.end(data)
}

interface StringMap<T> {
    [index: string]: T;
}

interface FileEntry {
    path: string;
    url?: string;
    content?: string;
    updated?: boolean;
}

function mkDirP(path: string, mode = "777", cb?: () => void) {
    var elts = path.split(/\/|\\/)
    // we might have gotten a race here if we used async
    var mk = (i: number) => {
        if (i > 0) {
            var p = elts.slice(0, i).join("/")
            if (!fs.existsSync(p)) {
                mk(i - 1)
                fs.mkdirSync(p, mode)
            }
        }
    }
    mk(elts.length - 1)
    if (cb) cb();
}

function processFileEntry(fe: FileEntry, f) {
    var state = tdstate.downloadedFiles

    fe.path = fe.path.replace(/\\/g, "/")

    if (fe.url && state[fe.path] === fe.url) {
        f(null)
        return
    }

    var prevUrl = state[fe.path]
    mkDirP(fe.path);

    state[fe.path] = "undefined://"
    saveState()

    var final = err => {
        if (!err) {
            state[fe.path] = fe.url
            saveState()
        }
        f(err)
    }

    if (fe.content) {
        var h = crypto.createHash("sha256")
        h.update(new Buffer(fe.content, "utf8"))
        fe.url = "sha256://" + h.digest("hex")
        if (fe.url != prevUrl)
            fe.updated = true
        debug.log('writefile: ' + fe.path + ' ' + fe.url);
        fs.writeFile(fe.path, fe.content, "utf8", final)
    } else {
        fe.updated = true
        downloadFile(fe.url, (err, s) => {
            if (err) f(err)
            else {
                debug.log('writefile: ' + fe.path);
                fs.writeFile(fe.path, s, null, final)
            }
        })
    }
}

function lazyRequire(pkg: string, finish: (md: any) => void) {
    try {
        var md = require(pkg.split('@')[0]);
        finish(md);
    }
    catch (e) {
        executeNpm(["install", pkg], function () {
            var md = require(pkg.split('@')[0]);
            finish(md);
        });
    }
}

function executeNpm(args: string[], finish: () => void) {
    // NPM_JS_PATH defined in Azure Web Apps
    var p = process.env["NPM_JS_PATH"] || path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
    if (!fs.existsSync(p))
        p = path.join(path.dirname(process.execPath).replace("/bin", "/lib"), "node_modules/npm/bin/npm-cli.js")
    if (!fs.existsSync(p))
        p = path.join(path.dirname(process.execPath).replace("/bin", "/libexec/npm/lib"), "node_modules/npm/bin/npm-cli.js")
    if (!fs.existsSync(p))
        p = process.execPath.replace(/nodejs.*/, "npm/1.4.10/node_modules/npm/bin/npm-cli.js")
    info.log("running npm, " + p)
    child_process.execFile(process.execPath, [p].concat(args), {}, (err, stdout, stderr) => {
        if (err)
            error.log("npm failure: " + err)
        if (stdout)
            info.log("npm install output: " + stdout)
        if (stderr)
            error.log("npm install error: " + stderr)
        finish()
    })
}

function deploy(d: any, cb: (err: any, resp: any) => void, isScript = true) {
    var numFiles = 1
    var hadExn = false
    var runNpm = false

    preventRestart(5);

    info.log("starting deployment")

    var finish = () => {
        if (!isScript) {
            cb(null, { status: "ok" })
            return
        }

        try {
            reloadScript()
            scriptLoadPromise.done(() => cb(null, { status: "ok" }),
                err => {
                    handleError(err)
                    cb(err, null)
                })
        } catch (e) {
            handleError(e)
            cb(e, null)
        }
    }

    var oneUp = () => {
        if (numFiles == 0 || --numFiles == 0) {
            if (runNpm) {
                runNpm = false
                executeNpm(["install", "--production"], oneUp)
            } else {
                finish()
            }
        }
    }

    if (isScript) {
        tdstate.numDeploys = (tdstate.numDeploys || 0) + 1
        tdstate.deployedId = ""
        tdstate.dmeta = d.dmeta || {}
        tdstate.dmeta.activationtime = Math.round(Date.now() / 1000)
        saveState()
    }

    debug.log("deploy: " + JSON.stringify(d.files.map(f => f.path)));

    d.files.forEach(fe => {
        numFiles++
        processFileEntry(fe, err => {
            if (isScript && fe.path == "package.json" && fe.updated)
                runNpm = true
            if (hadExn || err) tdstate.downloadedFiles = {}
            if (hadExn) saveState();
            else if (err) {
                hadExn = true
                saveState()
                cb(err, null)
            } else {
                oneUp()
            }
        })
    })

    oneUp()
}

export interface RunCliOptions {
    command: string;
    args?: string[];
    stdin?: string;
    streamStdin?: boolean;
    cwd?: string;
    env?: any;
}

function clone<T>(obj: T): T {
    var r = new (<any>obj).constructor
    for (var k in obj) {
        if (obj.hasOwnProperty(k))
            r[k] = obj[k]
    }
    return <T>r
}

function createProcess(d: RunCliOptions) {
    var isWin = /^win/.test(os.platform())
    debug.log("running: " + (d.cwd || "") + ">" + d.command + (d.args ? (" " + d.args.join(" ")) : ""))
    var env = clone(process.env);
    if (d.env) Object.keys(d.env).forEach(k => env[k] = d.env[k]);
    var proc = child_process.spawn(d.args ? d.command : isWin ? "cmd" : "sh", d.args || [isWin ? "/c" : "-c", d.command], {
        cwd: d.cwd || undefined,
        env: env,
    })

    //proc.stdin.setEncoding("utf8")
    proc.stdout.setEncoding("utf8")
    proc.stderr.setEncoding("utf8")

    return proc
}

function runCommand(d: RunCliOptions, f) {
    var proc = createProcess(d)

    proc.stdin.write(d.stdin || "", "utf8");
    proc.stdin.end();

    var stdout = ""
    var stderr = ""

    proc.stdout.on("data", data => {
        process.stdout.write(data)
        stdout += data
    })

    proc.stderr.on("data", data => {
        process.stdout.write(data)
        stderr += data
    })

    proc.on("exit", code => {
        f({
            code: code,
            stdout: stdout,
            stderr: stderr,
        })
    })
}

function deployAr(ar: ApiRequest, isScript: boolean) {
    var final = (err, resp) => {
        if (err) ar.ok({ status: "error", message: err + "" })
        else ar.ok(resp)
    }

    if (isScript && blobChannel) {
        var n = Math.round((Date.now() / 1000))
        var did = crypto.randomBytes(8).toString("hex")
        var id = (100000000000 - n) + "." + crypto.randomBytes(8).toString("hex")
        setBlobJson(id, ar.data, err => {
            if (err) ar.exception(err)
            else
                setBlobJson("000ch-" + blobChannel, {
                    blob: id,
                    time: n,
                    did: did,
                }, err => {
                    if (err) ar.exception(err)
                    else {
                        blobDeployCallback = final
                        checkUpdate()
                    }
                })
        })
        return
    }

    if (!isScript)
        tdstate.downloadedFiles = {}

    deploy(ar.data, final, isScript)
}

var mgmt: StringMap<(ar: ApiRequest) => void> = {
    config: ar => {
        ar.ok(config)
    },

    stats: ar => {
        ar.ok({
            shellVersion: config.shellVersion,
            shellSha: shellSha(),
            memory: process.memoryUsage(),
            uptime: process.uptime(),
            nodeVersion: process.version,
            argv: process.argv,
            numMgmtRequests: currentReqNo,
            numDeploys: tdstate.numDeploys,
            numContentRequests: numResponses,
            dmeta: tdstate.dmeta,
            encryption: !!key,
            onlyEncrypted: onlyEncrypted,
            versionStamp: "v21",
        })
    },

    info: ar => ar.forwardToWorkers(),

    logs: ar => {
        ar.ok({
            shellVersion: config.shellVersion,
            error: error.getMsgs(),
            info: info.getMsgs(),
            debug: debug.getMsgs(),
        })
    },

    combinedlogs: ar => {
        var msgs = error.getMsgs().concat(info.getMsgs()).concat(debug.getMsgs())
        msgs.sort((a, b) => b.timestamp - a.timestamp)
        ar.ok({
            shellVersion: config.shellVersion,
            logs: msgs,
        })
    },

    exit: ar => {
        nodeExit()
        ar.ok({ msg: "This probably won't make it out." })
    },

    runcli: ar => {
        runCommand(ar.data, r => ar.ok(r))
    },

    writefiles: ar => deployAr(ar, false),

    deploy: ar => deployAr(ar, true),

    getconfig: ar => {
        if (!blobChannel) {
            ar.error(400, "get config only available when deployed via azure storage")
            return
        }

        getBlobJson("000cfg-" + blobChannel, (err, cdata) => {
            if (!cdata) cdata = { AppSettings: [] }
            ar.ok(cdata)
        })
    },

    setconfig: ar => {
        if (!blobChannel) {
            ar.error(400, "set config only available when deployed via azure storage")
            return
        }

        getBlobJson("000cfg-" + blobChannel, (err, cdata) => {
            if (!cdata) cdata = {}
            Object.keys(ar.data).forEach(k => cdata[k] = ar.data[k])
            setBlobJson("000cfg-" + blobChannel, cdata, err => {
                if (err) {
                    ar.exception(err)
                    return
                }

                getBlobJson("000ch-" + blobChannel, (err, data) => {
                    if (err) {
                        ar.exception(err)
                        return
                    }
                    data.did = crypto.randomBytes(8).toString("hex")
                    setBlobJson("000ch-" + blobChannel, data, err => {
                        if (err)
                            ar.exception(err)
                        else
                            ar.ok(cdata)
                    })
                })
            })
        })
    },
}

function saveState() {
    fs.writeFileSync(dataPath("tdstate.json"), JSON.stringify(tdstate))
}

function getMime(filename: string) {
    var ext = path.extname(filename).slice(1)
    switch (ext) {
        case "txt": return "text/plain";
        case "html":
        case "htm": return "text/html";
        case "css": return "text/css";
        case "ts": return "text/plain";
        case "js": return "application/javascript";
        case "jpg":
        case "jpeg": return "image/jpeg";
        case "png": return "image/png";
        case "ico": return "image/x-icon";
        case "manifest": return "text/cache-manifest";
        case "json": return "application/json";
        case "svg": return "image/svg+xml";
        default: return "application/octet-stream";
    }
}

var needsStop = false
var scriptLoadPromise: any;
var rootDir = ""

function loadScript(f) {
    scriptLoadPromise.done(f)
}

function reloadScript() {
    scriptLoadPromise = loadScriptCoreAsync();
}

function findFreePort(cb: (p: number) => void) {
    var port = Math.floor(Math.random() * 50000 + 10000)
    var tester = net.createServer()
    tester.on("error", err => findFreePort(cb))
    tester.listen(port, err => {
        tester.once('close', () => cb(port))
        tester.close()
    })
}

var logException = (msg: string) => { }

class Worker {
    public socketPath: string;
    public port: number;
    public child: child_process.ChildProcess
    public isready: boolean;
    public iscurrent: boolean;
    public isdying: boolean;
    public startTime = Date.now();

    public shutdown() {
        var u = this.getUrl()
        u.path = "/-tdevmgmt-/" + config.deploymentKey + "/shutdown"
        debug.log("sending shutdown request")
        var creq = http.request(u, cres => {
            debug.log("shutdown request: " + cres.statusCode)
        })
        creq.on("error", err => {
            debug.log("shutdown request error: " + err.message)
        })
        creq.end()

        this.isdying = true;
        setTimeout(() => {
            if (this.child) {
                debug.log("sending kill signal")
                this.child.kill()
            }
            setTimeout(() => {
                if (this.child) this.child.kill("SIGKILL")
            }, 5000)
        }, 3 * 60000)
    }

    public description() {
        return "port:" + (this.socketPath || this.port) + ", pid:" + (this.child ? this.child.pid : "?")
    }

    private died() {
        this.isready = false;
        this.isdying = true;
        if (this.child) {
            this.child = null
            var idx = workers.indexOf(this)
            if (idx >= 0) {
                workers.splice(idx, 1)
                var runtime = Date.now() - this.startTime
                info.log("worker was active, now have " + workers.length + " left, time: " + runtime)
                if (workers.length <= numWorkers / 2 && runtime > 60000) {
                    info.log("active worker died after at least a minute; restarting all workers")
                    reloadScript()
                }
            }
        }
    }

    public init(cb: () => void) {
        info.log("worker start " + this.description())
        this.child.on("exit", code => {
            info.log("worker exit " + code + " : " + this.description())
            this.died()
        })

        this.child.on("error", err => {
            error.log(err.message || err)
            this.died()
        })

        this.child.stderr.setEncoding("utf8")
        this.child.stderr.on("data", d => {
            info.log("CHILD_ERR: " + d.replace(/\n$/, ""))
        })

        this.child.stdout.setEncoding("utf8")
        this.child.stdout.on("data", d => {
            debug.log(d.replace(/\n$/, ""))
        })

        var numPing = 0
        var ping = () => {
            if (++numPing > 120) {
                error.log("cannot start worker, #pings " + numPing)
                return
            }

            var u = this.getUrl()
            u.path = "/-tdevmgmt-/" + config.deploymentKey + "/ready"
            debug.log("worker ping, " + this.description())
            var creq = http.request(u, cres => {
                if (cres.statusCode == 200) {
                    if (this.isdying) return
                    if (!this.isready) {
                        info.log("worker ready, " + this.description())
                        this.isready = true
                        cb()
                    }
                } else {
                    debug.log("ping failed, " + cres.statusCode)
                    setTimeout(ping, 1000)
                }
            })
            creq.on("error", err => {
                if (this.isready || this.child == null) {
                    debug.log("error, but no need to ping anymore, " + this.description())
                    return
                }

                if (err.code == 'ECONNREFUSED') { }
                else debug.log("ping failed, " + err.message)
                setTimeout(ping, 1000)
            })
            creq.end()
        }
        ping()
    }

    public getUrl(): any {
        if (this.socketPath)
            return { socketPath: this.socketPath }
        else
            return {
                hostname: "127.0.0.1",
                port: this.port
            }
    }
}

var workers: Worker[] = []
var allWorkers: Worker[] = []
var totalWorkers = 0;
var whenWorkers = []


function startWorker(cb0, cb) {
    var isWin = /^win/.test(os.platform())

    var w = new Worker()

    var env = JSON.parse(JSON.stringify(process.env))
    Object.keys(additionalEnv).forEach(k => env[k] = additionalEnv[k])
    env['TD_WORKER_ID'] = ++totalWorkers;
    env['TD_DEPLOYMENT_META'] = JSON.stringify(tdstate.dmeta || {})


    var fin = () => {
        debug.log("forking child script, " + w.description())

        w.child = child_process.fork("./script/compiled.js", [], {
            env: env,
            silent: true,
        } as any)
        w.init(cb)

        cb0(w)
    }

    if (useFileSockets) {
        var sockPath = "tdsh." + crypto.randomBytes(16).toString("hex")
        env.PORT = isWin ? "\\\\.\\pipe\\" + sockPath : "/tmp/." + sockPath
        w.socketPath = env.PORT
        fin()
    } else {
        findFreePort(num => {
            w.port = num
            env.PORT = w.port
            fin()
        })
    }
}

var loadVersion = new Object();
var restartTime = 0;

function preventRestart(mins: number) {
    loadVersion = new Object()
    restartTime = Math.max(Date.now() + mins * 60 * 1000, restartTime)
}

function loadScriptCoreAsync() {
    if (numWorkers < 0) {
        numWorkers = Math.round(os.cpus().length * -numWorkers)
    }
    numWorkers = Math.round(numWorkers)
    if (numWorkers <= 0) numWorkers = 1

    // at most 5min startup time
    preventRestart(5);
    var myVersion = loadVersion;
    restartInterval = parseInt(additionalEnv['TD_RESTART_INTERVAL'] || process.env['TD_RESTART_INTERVAL'] || "0") || 0

    var newWorkers: Worker[] = []

    var numW = numWorkers
    var oneUp = () => {
        if (loadVersion != myVersion) return
        if (--numW == 0) {
            allWorkers.forEach(w => w.iscurrent = false)
            newWorkers.forEach(w => w.iscurrent = true)
            workers = newWorkers.slice(0)

            allWorkers.forEach(w => w.iscurrent || w.shutdown())
            allWorkers = newWorkers.slice(0)

            var l = whenWorkers
            whenWorkers = []
            l.forEach(f => f())

            if (restartInterval > 0)
                // randomize the time a bit
                restartTime = Date.now() + Math.round((restartInterval * (0.5 + Math.random())) * 1000)
            else
                restartTime = 0;
        }
    }

    for (var i = 0; i < numWorkers; ++i)
        startWorker(w => {
            newWorkers.push(w)
            allWorkers.push(w)
        }, oneUp)

    return {
        then: f => f(),
        done: f => f()
    }
}

var loadedModules: any = {}

function loadModule(name: string, f: (mod) => void) {
    if (loadedModules.hasOwnProperty(name))
        f(loadedModules[name])
    else {
        var finish = () => {
            var mod = require(name)
            loadedModules[name] = mod
            debug.log("module " + name + " loaded")
            f(mod)
        }

        if (fs.existsSync(rootDir + "/node_modules/" + name))
            finish()
        else
            executeNpm(["install", name], finish)
    }
}

function loadWsModule(f: () => void) {
}

function nodeExit() {
    // process.exit(1) doesn't seem to work, at least on RPI
    process.kill(process.pid, "SIGTERM")
}

var editorCache: any;

function cacheError(err: any) {
    error.log(err + "")
}

var key: Buffer = null;
var onlyEncrypted = false;

function decipherReq(req) {
    var err = function (m) {
        console.log("decipher: " + m)
    }

    if (!key) return req;

    var iv = req.headers["x-tdshell-iv"]
    if (!iv) {
        err("No iv")
        return req
    }
    iv = new Buffer(iv.replace(/\s+/g, ""), "hex")
    if (!iv || iv.length != 16) {
        err("bad iv")
        return req
    }

    var ciph = <any>crypto.createDecipheriv("AES256", key, iv)
    req.pipe(ciph)
    ciph.tdEncrypted = true
    return ciph
}

function cipherResp(res) {
    if (!key) return res;
    var oiv = crypto.randomBytes(16)
    res.setHeader("x-tdshell-iv", oiv.toString("hex"))
    var enciph = <any>crypto.createCipheriv("AES256", key, oiv)
    enciph.pipe(res);
    var g = zlib.createGzip(undefined);
    g.pipe(enciph)
    return g
}

function specHandleReq(req, resp) {
    var ar = new ApiRequest(req, resp);
    try {
        var u = url.parse(req.url);
        var uu = u.pathname
        if (uu == "/") uu = "index.html";
        if (!/^[\/\\]/.test(uu)) uu = "/" + uu
        uu = path.normalize(uu).replace(/^[\/\\]+/, "").replace(/\\/g, "/")

        var cmd = uu.split(/\//)

        debug.log(req.method + " " + req.url)

        if (cmd[0] == "-tdevmgmt-") {
            ar.setCors();
            if (req.method == "OPTIONS") {
                resp.writeHead(200, "OK");
                resp.end();
            } else {
                if (cmd[1] === "encrypted") {
                    ar.handleEncryptedMgmt()
                } else if (cmd[1] === config.deploymentKey) {
                    if (onlyEncrypted)
                        ar.error(418, "only encrypted allowed")
                    else
                        ar.handleMgmt(cmd.slice(2))
                } else {
                    ar.error(403, "wrong key")
                }
            }
            return
        } else {
            ar.error(404, "No script deployed")
        }

    } catch (e) {
        ar.exception(e)
    }
}

function pickWorker() {
    return workers[Math.floor(Math.random() * workers.length)]
}

function setupHeaders(req) {
    if (!trustXff) {
        req.headers['x-forwarded-for'] = req.connection.remoteAddress
        req.headers['x-forwarded-proto'] = req.connection.encrypted ? "https" : "http"
    } else {
        var fw = req.headers['x-forwarded-for']
        if (fw) {
            // IIS (or IISNode) likes to include port number in X-Forwarded-For header
            var m = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(fw)
            if (m) req.headers['x-forwarded-for'] = m[1]
        }
        if (!req.headers['x-forwarded-proto'] && req.headers['x-arr-ssl'] && process.env['IISNODE_VERSION'])
            req.headers['x-forwarded-proto'] = 'https'
    }
}

function forwardWebSocket(req, sock, body) {
    var w = pickWorker()
    var u = w.getUrl()
    if (u.socketPath)
        u.path = u.socketPath
    var fwd = net.connect(u, () => {
        setupHeaders(req)
        var hds = req.method + " " + req.url + " HTTP/1.1\r\n"
        Object.keys(req.headers).forEach(h => {
            hds += h + ": " + req.headers[h] + "\r\n"
        })
        hds += "\r\n"
        fwd.write(hds)
        if (body)
            fwd.write(body)
        sock.pipe(fwd)
        fwd.pipe(sock)
    })
}

function handleReq(req, resp) {
    setupHeaders(req)

    if (/^\/-tdevmgmt-/.test(req.url)) {
        specHandleReq(req, resp)
        return;
    }

    if (onlyEncrypted) {
        resp.writeHead(418, "Only encrypted allowed")
        resp.end("Only encrypted allowed")
        return
    }

    if (workers.length == 0)
        whenWorkers.push(() => handleReq(req, resp))
    else {
        var w = pickWorker()
        var u = w.getUrl()
        u.method = req.method
        u.headers = req.headers
        if (u.headers['connection'] == "close")
            delete u.headers['connection'];
        u.path = req.url

        var creq = http.request(u, cres => {
            numResponses++
            resp.writeHead(cres.statusCode, cres.headers)
            cres.pipe(resp);
        })

        req.pipe(creq)
    }
}

function handleError(err) {
    error.log("exception (top): " + err.toString() + "\n" + err.stack)
    logException("unhandled exception: " + err.toString() + "\n" + err.stack)
}

function respawnLoop() {
    info.log('starting shell watch...')

    function copy() {
        debug.log("copying touchdevelop.js to local folder...")
        var src = fs.readFileSync(__filename, "utf8")
        fs.writeFileSync("tdserver.js", src, "utf8")
    }

    // process.env["TD_AUTO_UPDATE_ENABLED"] = "true"

    var attempts = 0;

    function startOne() {
        var startTime = Date.now()
        var child = child_process.fork(process.cwd() + "/tdserver.js", process.argv.slice(2))
        child.on("exit", (code) => {
            debug.log("local folder touchdevelop exit, " + code)
            if (code === 0) {
                if (++attempts > 10) {
                    console.error("Too many failures, aborting. Please retry manually.");
                    process.exit();
                } else {
                    debug.log("Failure, retrying in 5s...");
                    setTimeout(startOne, 5000);
                }
            }
        })
    }

    if (!fs.existsSync("tdserver.js"))
        copy();
    startOne();
}

var _shellSha = ""
function shellSha() {
    if (!_shellSha) {
        var h = crypto.createHash("sha256")
        h.update(fs.readFileSync(__filename))
        _shellSha = h.digest("hex").toLowerCase()
    }

    return _shellSha;
}


var blobSvc;
var containerName = 'tddeployments'
var updateDelay = 3000;
var lastAzureDeployment = "";
var additionalEnv: StringMap<string> = {}
var updateWatchdog = 0;
var blobDeployCallback;

function setBlobJson(name: string, json, f) {
    blobSvc.createBlockBlobFromText(containerName, name, JSON.stringify(json, null, 2), f)
}

function getBlobJson(name: string, f) {
    blobSvc.getBlobToText(containerName, name, (err, data) => {
        f(err, data ? JSON.parse(data) : null)
    })
}

function applyConfig(cfg) {
    if (!cfg) return

    if (cfg.AppSettings) {
        cfg.AppSettings.forEach(s => {
            additionalEnv[s.Name] = s.Value
        })
    }
}

function checkUpdate() {
    var n = Date.now()
    if (n - updateWatchdog < 25000)
        return
    updateWatchdog = n
    var reset = () => {
        if (updateWatchdog == n) updateWatchdog = 0
    }

    getBlobJson("000ch-" + blobChannel, (err, d) => {
        if (d && d.blob && d.did != lastAzureDeployment) {
            preventRestart(5);
            info.log("new deployment, " + d.blob)
            getBlobJson("000cfg-" + blobChannel, (err, cfg) => {
                if (!err) applyConfig(cfg)

                if (d.did == lastAzureDeployment) return // race?

                var fin = () =>
                    getBlobJson(d.blob, (err, data) => {
                        lastAzureDeployment = d.did
                        if (data) {
                            if (!data.dmeta) data.dmeta = {}
                            data.dmeta.blobid = d.blob
                            data.dmeta.deploytime = d.time
                            deploy(data, (err, resp) => {
                                var f = blobDeployCallback
                                blobDeployCallback = null
                                if (f) f(err, resp)
                                if (err)
                                    error.log("cannot deploy: " + err)
                                else
                                    info.log(resp)
                                reset()
                            })
                        } else {
                            error.log("cannot fetch deployment: " + err.message)
                            reset()
                        }
                    })

                withVault(fin)
            })
        } else {
            if (err && err.statusCode != 404)
                console.log(err)
            reset()
        }
    })
}

function loadAzureStorage(f) {
    loadModule("azure-storage", az => {
        if (!blobSvc)
            blobSvc = az.createBlobService()
        blobSvc.createContainerIfNotExists(containerName, err => {
            if (err)
                throw err;
            setInterval(checkUpdate, updateDelay)
        })
        checkUpdate()
        f()
    })
}

function networkIP(): string {
    var interfaces = os.networkInterfaces();
    var addresses = [];
    for (var k in interfaces) {
        for (var k2 in interfaces[k]) {
            var address = interfaces[k][k2];
            if (address.family === 'IPv4' && !address.internal) {
                return address.address;
            }
        }
    }
    return "localhost";
}

interface StoredCert {
    cert: string;
    domains: string[];
    isDefault: boolean;
}

function withVault(inner: () => void) {
    if (vaultUrl) {
        vaultToken = ""
        downloadSecret(vaultUrl, d => {
            var env = JSON.parse(d.value)
            var pfx0 = env['TD_HTTPS_PFX'] // legacy
            delete env['TD_HTTPS_PFX']

            let pfxPassword = env["PFX_PASSWORD"] // current

            // legacy
            let manyPfxPass = env["TD_CERT_JSON_PASSWORD"]
            let manyPfxName = env["TD_CERT_JSON_NAME"]
            delete env['TD_CERT_JSON_PASSWORD']
            delete env['TD_CERT_JSON_NAME']

            if (pfx0) pfx = pfx0
            Object.keys(env).forEach(k => {
                if (process.env[k] != env[k])
                    debug.log("vault: setting " + k)
                process.env[k] = env[k]
            })

            if (pfxPassword)
                downloadSecret(vaultUrl.replace(/[^\/]+$/, "cert"), d => {
                    if (d && d.value)
                        pfx = d.value
                    loadAzureStorage(() => {
                        getBlobJson("certs.json", (err, val) => {
                            let certs = (val || []) as StoredCert[]
                            domainContexts = {}
                            defaultContext = null
                            for (let cert of certs) {
                                let ctx = tls.createSecureContext({
                                    pfx: new Buffer(cert.cert, "base64"),
                                    passphrase: pfxPassword
                                })
                                for (let d of cert.domains)
                                    domainContexts[d.toLowerCase()] = ctx
                                if (cert.isDefault)
                                    defaultContext = ctx
                            }

                            if (!defaultContext)
                                defaultContext = tls.createSecureContext({
                                    pfx: new Buffer(pfx, "base64")
                                })

                            inner()
                        })
                    })
                })
            else if (manyPfxName && manyPfxPass)
                loadAzureStorage(() => {
                    getBlobJson(manyPfxName, (err, val) => {
                        let enc = new Buffer(val.encrypted, "base64")
                        let ciph = crypto.createDecipher("AES256", new Buffer(manyPfxPass, "base64"))
                        let prev = ciph.update(enc)
                        let buf = Buffer.concat([prev, ciph.final()])
                        let certs = JSON.parse(buf.toString("utf8")) as StoredCert[]
                        domainContexts = {}
                        defaultContext = null
                        for (let cert of certs) {
                            let ctx = tls.createSecureContext({
                                pfx: new Buffer(cert.cert, "base64")
                            })
                            for (let d of cert.domains)
                                domainContexts[d.toLowerCase()] = ctx
                            if (cert.isDefault)
                                defaultContext = ctx
                        }
                        if (!defaultContext && pfx)
                            defaultContext = tls.createSecureContext({
                                pfx: new Buffer(pfx, "base64")
                            })
                        inner()
                    })
                })
            else inner()
        })
    } else inner()
}

function readCerts(secretsJson: string, cb) {
    let secr = JSON.parse(fs.readFileSync(secretsJson, "utf8"))
    let certsDir = "certs"
    if (!secr["PFX_PASSWORD"] && fs.existsSync(certsDir)) {
        let certs: StoredCert[] = []
        let defl = ""
        for (let f of fs.readdirSync(certsDir)) {
            if (/\.pfx$/.test(f)) {
                let certName = certsDir + "/" + f
                console.log("\n***")
                console.log("Parsing", certName)
                let res = child_process.execFileSync("openssl",
                    ["pkcs12", "-password", "pass:", "-clcerts", "-nokeys",
                        "-in", certName]) as any as Buffer
                fs.writeFileSync("tmp.cer", res)
                res = child_process.execFileSync("openssl", ["x509", "-text", "-in", "tmp.cer"]) as any
                fs.unlinkSync("tmp.cer")
                let desc = res.toString("utf8")
                let m = /^\s*Subject:.*CN=(\S+)/m.exec(desc)
                let cn = m[1]
                m = /^\s*X509.* Subject Alternative Name:\s*(DNS.*)/m.exec(desc)
                let names = [cn]
                if (m) {
                    names = m[1].replace(/DNS:/g, "").split(/,\s*/)
                    if (names.indexOf(cn) < 0) names.unshift(cn)
                }
                console.log(`${f}: ${names.join(", ")}`)
                let info: StoredCert = {
                    domains: names,
                    cert: fs.readFileSync(certName).toString("base64"),
                    isDefault: false
                }
                if (f == "default.pfx") {
                    defl = info.cert
                    info.isDefault = true
                }
                certs.push(info)
            }
        }
        let data = new Buffer(JSON.stringify(certs, null, 4), "utf8")
        let pass = crypto.randomBytes(16)
        let ciph = crypto.createCipher("AES256", pass)
        let first = ciph.update(data)
        let enc = Buffer.concat([first, ciph.final()])

        if (!defl) {
            console.log("No certs/default.pfx file. Aborting")
            process.exit(1)
        }

        secr["TD_HTTPS_PFX"] = defl
        secr["TD_CERT_JSON_PASSWORD"] = pass.toString("base64")
        let jsonName = "cert-" + crypto.randomBytes(8).toString("hex") + ".json"
        secr["TD_CERT_JSON_NAME"] = jsonName

        process.env["AZURE_STORAGE_ACCOUNT"] = secr["AZURE_STORAGE_ACCOUNT"]
        process.env["AZURE_STORAGE_ACCESS_KEY"] = secr["AZURE_STORAGE_ACCESS_KEY"]

        console.log("\n***\n***\n")

        loadAzureStorage(() =>
            setBlobJson(jsonName, { encrypted: enc.toString("base64") }, () => {
                console.log("blob uploaded")
                cb(secr)
            }))
    } else cb(secr)
}

function httpsSni(servername: string, cb) {
    let s = servername.toLowerCase()
    let ctx = defaultContext
    if (domainContexts.hasOwnProperty(s)) {
        ctx = domainContexts[s]
    } else {
        s = s.replace(/^[^.]+/, "*")
        if (domainContexts.hasOwnProperty(s)) {
            ctx = domainContexts[s]
        }
    }
    if (cb)
        cb(null, ctx)
    else
        return ctx
}

function main() {
    var agent = (<any>http).globalAgent;
    agent.keepAlive = true;
    if (agent.options) agent.options.keepAlive = true;
    agent.maxSockets = Infinity;
    // don't limit maxSockets - they might be long-living

    inAzure = !!process.env.PORT;
    var port = process.env.PORT || 4242;


    rootDir = process.cwd()

    var args = process.argv.slice(2)
    var internet = inAzure ? true : false

    inNodeWebkit = fs.existsSync("./app.html");

    var usage = () => {
        console.error("unknown option: " + args[0])

        console.error("Options:")
        console.error("  --port NUMBER     -- port to listen to (-p)")
        console.error("  --internet        -- allow connections from outside localhost")
        console.error("  --workers NUMBER  -- number of worker servers to start (-w); negative to multiply by number of cores")
        console.error("  NAME=VALUE        -- set environment variable for the script")
        console.error("")
        console.error("Supported environment variable options:")
        console.error("TD_BLOB_DEPLOY_CHANNEL  -- deploy from Azure blob storage, using named channel")
        console.error("TD_WORKERS              -- same as --workers option")
        console.error("TD_TRUST_XFF            -- if non-empty trust X-Forwarded-For header")
        console.error("TD_RESTART_INTERVAL     -- how often to restart workers, [s], 0 or unset to disable")
        console.error("")
        console.error("Azure Web Apps compatibility:")
        console.error("IISNODE_VERSION         -- same as TD_TRUST_XFF")
        console.error("PORT                    -- same as --port $PORT --internet and disable console logging")
        console.error("")
        console.error("HTTPS support:")
        console.error("TD_HTTPS_PFX            -- if set to base64-encoded .pfx file, enables TLS/SSL/HTTPS")
        console.error("TD_TLS_CIPHERS          -- :-separated list of ciphers; otherwise uses io.js (not node.js) defaults")
        console.error("HTTPS_PORT              -- defaults to 443; only used when TD_HTTPS_PFX is set")
        console.error("")
        console.error("KEY_VAULT_URL           -- eg: https://foobar.vault.azure.net/secrets/myenv")
        console.error("KEY_VAULT_CLIENT_ID     -- eg: 58127cfc-dc7e-46d3-9ab6-3d33ae67de0f")
        console.error("KEY_VAULT_CLIENT_SECRET -- eg: m/c4FooBaR42eNa+VCfOObAr42dkL4D42i+u90uIq1c=")
        console.error("  --putsecret FILE      -- upload given Key Vault secret")

        process.exit(1)
    }

    trustXff = !!(process.env['TD_TRUST_XFF'] || process.env['IISNODE_VERSION'])

    if (!inAzure && !inNodeWebkit && __dirname != process.cwd()) {
        if (isNpm) process.env["TD_ALLOW_EDITOR"] = "true"
        respawnLoop()
        return
    }

    debug.log("starting with " + args.join(" ") + ", pid: " + process.pid)

    if (process.env['TD_WORKERS']) {
        numWorkers = parseFloat(process.env['TD_WORKERS']) || 1
    }

    var sslport = process.env.HTTPS_PORT || 443;
    pfx = process.env['TD_HTTPS_PFX']

    // we don't really want the workers to see this
    delete process.env['TD_HTTPS_PFX']

    var putSecret = ""
    var getSecret = ""

    while (args.length > 0) {
        switch (args[0]) {
            case "-w":
            case "--workers":
                args.shift()
                numWorkers = parseFloat(args.shift()) || 1
                break;
            case "-p":
            case "--port":
                args.shift()
                port = parseInt(args.shift())
                break;
            case "--internet":
                args.shift()
                internet = true
                break
            case "--putsecret":
                args.shift()
                putSecret = args.shift()
                break;
            case "--getsecret":
                args.shift()
                getSecret = args.shift()
                break;
            default:
                var m = /^([A-Za-z0-9_]+)=(.*)$/.exec(args[0])
                if (m) {
                    debug.log("set " + m[1] + "=" + m[2]);
                    process.env[m[1]] = m[2]
                    args.shift()
                } else {
                    usage()
                }
                break;
        }
    }


    debug.log("start")

    var tdConfigJson = dataPath("tdconfig.json");
    if (process.env['TD_LOCAL_DROP'] || !fs.existsSync(tdConfigJson)) {
        debug.log("generating initial tdconfig.json")
        config = {
            deploymentKey: crypto.randomBytes(20).toString("hex").toLowerCase(),
            timestamp: Date.now(),
            tiemstampText: new Date().toString(),
            shellVersion: 108
        }
        fs.writeFileSync(tdConfigJson, JSON.stringify(config, null, 2))
    }

    config = JSON.parse(fs.readFileSync(tdConfigJson, "utf8"))

    onlyEncrypted = false
    if (/^\*/.test(process.env['TD_DEPLOYMENT_KEY'])) {
        onlyEncrypted = true
        process.env['TD_DEPLOYMENT_KEY'] = process.env['TD_DEPLOYMENT_KEY'].slice(1)
    }

    if (process.env['TD_DEPLOYMENT_KEY']) {
        config.deploymentKey = process.env['TD_DEPLOYMENT_KEY']
    }

    {
        var h = crypto.createHash("sha256")
        h.update(config.deploymentKey)
        key = h.digest()
    }

    info.log("Deployment key: " + config.deploymentKey);

    var tdStateJson = dataPath("tdstate.json")
    if (fs.existsSync(tdStateJson))
        tdstate = JSON.parse(fs.readFileSync(tdStateJson, "utf8"))
    else
        tdstate = { downloadedFiles: {}, numDeploys: 0, deployedId: "", dmeta: {} }

    process.on('uncaughtException', handleError)

    vaultUrl = process.env['KEY_VAULT_URL']
    vaultSecret = process.env['KEY_VAULT_CLIENT_SECRET']
    vaultClientId = process.env['KEY_VAULT_CLIENT_ID']
    delete process.env['KEY_VAULT_URL']
    delete process.env['KEY_VAULT_CLIENT_ID']
    delete process.env['KEY_VAULT_CLIENT_SECRET']

    if (vaultUrl) {
        if (!vaultSecret || !vaultClientId) {
            error.log("missing KEY_VAULT_CLIENT_ID or KEY_VAULT_CLIENT_SECRET")
            process.exit(1)
        }

        if (putSecret) {
            readCerts(putSecret, (j) => {
                downloadSecret(vaultUrl, d => {
                    delete d.value;
                    console.log(d)
                    info.log("secret uploaded")
                    process.exit(0)
                }, {
                        put: {
                            value: JSON.stringify(j, null, 4)
                        }
                    })
            })
            return
        } else if (getSecret) {
            downloadSecret(vaultUrl, d => {
                fs.writeFileSync(getSecret, d.value)
                process.exit(0)
            })
            return
        }
    }


    var startUp = () => {
        if (internet) {
            app.listen(port);
            if (sslport) sslapp.listen(sslport)
        } else {
            app.listen(port, "127.0.0.1")
            if (sslport) sslapp.listen(sslport, "127.0.0.1")
        }
        info.log('touch develop local started...')
    }

    var reload = () => {
        if (!tdstate.numDeploys) {
            startUp();
            return
        }
        info.log('reloading script...');
        try {
            reloadScript()
            scriptLoadPromise.done(startUp,
                err => {
                    handleError(err)
                    startUp()
                })
        } catch (e) {
            handleError(e)
            startUp()
        }
    }

    blobChannel = process.env['TD_BLOB_DEPLOY_CHANNEL']

    var webSocketHandler = (req, sock, body) =>
        loadModule("faye-websocket", wsModule => {
            (global as any).WebSocket = wsModule.Client
            if (!wsModule.isWebSocket(req)) {
                sock.end()
                return
            }

            if (workers.length > 0) {
                forwardWebSocket(req, sock, body)
            } else {
                sock.end()
            }
        })

    var app
    var sslapp

    tls.CLIENT_RENEG_LIMIT = 0

    var innerMain = () => {
        if (!pfx) sslport = 0
        app = http.createServer(handleReq);
        app.on("upgrade", webSocketHandler)

        setInterval(() => {
            if (restartTime && Date.now() >= restartTime) {
                restartTime = 0
                info.log("restart-time reached; reloading")
                withVault(reloadScript);
            }
        }, Math.round((Math.random() + 0.5) * 2000))

        if (sslport) {
            sslapp = https.createServer({
                pfx: new Buffer(pfx, "base64"),
                SNICallback: httpsSni as any,
            })
            sslapp.on("request", handleReq)
            sslapp.on("upgrade", webSocketHandler)

            var tlsSessionStoreCount = 0
            var tlsSessionStore = {}
            sslapp.on("newSession", (id, data, cb) => {
                id = id.toString("hex")
                if (tlsSessionStoreCount > 50000) {
                    tlsSessionStore = {}
                    tlsSessionStoreCount = 0
                }
                if (!tlsSessionStore.hasOwnProperty(id))
                    tlsSessionStoreCount++;
                tlsSessionStore[id] = data;
                cb(null)
            })
            sslapp.on("resumeSession", (id, cb) => {
                id = id.toString("hex")
                cb(null, tlsSessionStore[id] || null)
            })

        }

        if (blobChannel)
            loadAzureStorage(startUp)
        else
            reload()
    }

    withVault(innerMain)
}

main();
