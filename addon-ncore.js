const express = require("express"), path = require("path"), crypto = require("crypto"), { addonBuilder } = require("stremio-addon-sdk"), axios = require("axios"), FormData = require("form-data"), cheerio = require("cheerio");
const app = express(), PORT = process.env.PORT || 7001;

// Trust Render's reverse proxy to ensure HTTPS requests are handled correctly
app.set("trust proxy", true);

app.use((req, res, next) => {
    res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" });
    req.method === "OPTIONS" ? res.sendStatus(200) : next();
});

const formatBytes = b => { if (!b) return "0 B"; const i = Math.floor(Math.log(b) / Math.log(1024)); return parseFloat((b / Math.pow(1024, i)).toFixed(2)) + " " + ["B", "KB", "MB", "GB", "TB"][i]; };
const sanitizeQ = q => q?.replace(/['"’`:\-\._]/g, " ").replace(/\s+/g, " ").trim() || "";
const extractHash = buf => {
    try {
        let s = buf.toString('binary'), idx = s.indexOf('4:infod');
        if (idx === -1) return null;
        for (let start = idx + 6, lvl = 0, i = start; i < s.length; i++) {
            const c = s[i];
            if (c === 'd' || c === 'l') lvl++;
            else if (c === 'e') { if (lvl === 1) return crypto.createHash('sha1').update(Buffer.from(s.substring(start, i + 1), 'binary')).digest('hex').toLowerCase(); lvl--; }
            else if (c === 'i') i = s.indexOf('e', i);
            else if (c >= '0' && c <= '9') { let col = s.indexOf(':', i); i = col + parseInt(s.substring(i, col), 10); }
        }
    } catch (e) {} return null;
};

const detectLang = (t, cat) => {
    if (!t) return cat === "HUN" ? "🇭🇺 [HUN]" : "🇬🇧 [ENG]";
    const tu = t.toUpperCase();
    if (/\b(DUAL|HUN\.ENG|ENG\.HUN|HUN-ENG)\b/.test(tu) || (/\bHUN\b/.test(tu) && /\bENG\b/.test(tu))) return "🇭🇺+🇬🇧 [DUAL]";
    if (/\bMULTI\b/.test(tu)) return "🌐 [MULTi]";
    return cat === "HUN" || /\b(HUN|HUNGARIAN|MAGYAR)\b/.test(tu) ? "🇭🇺 [HUN]" : (cat === "ENG" || /\b(ENG|ENGLISH)\b/.test(tu) ? "🇬🇧 [ENG]" : "🇬🇧 [ENG]");
};

const findTargetFile = (files, s, e) => {
    if (!files?.length) return 1;
    const cands = files.filter(f => /\.(mkv|mp4|avi|mov|m2ts|ts|flv|webm)$/i.test(f.name));
    const list = cands.length ? cands : files;
    if (s && e) {
        const p = [new RegExp(`S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}\\b`,'i'), new RegExp(`S${s}E${e}\\b`,'i'), new RegExp(`\\b${s}x${String(e).padStart(2, '0')}\\b`,'i'), new RegExp(`\\bE(P)?${String(e).padStart(2, '0')}\\b.*S${String(s).padStart(2, '0')}`,'i')];
        const match = list.find(f => p.some(rx => rx.test(f.name)));
        if (match) return match.id;
    }
    return list.sort((a, b) => b.size - a.size)[0].id;
};

const autoCleanup = async key => {
    if (!key) return;
    try {
        const { data } = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", { headers: { Authorization: `Bearer ${key}` }});
        if (!data?.success || !Array.isArray(data.data)) return;
        const now = Date.now();
        await Promise.all(data.data.filter(t => now - new Date(t.created_at).getTime() >= 216000000).map(t => 
            axios.post("https://api.torbox.app/v1/api/torrents/controltorrent", { torrent_id: t.id, operation: "delete" }, { headers: { Authorization: `Bearer ${key}` }})
        ));
    } catch (e) {}
};

const getSession = async (u, p) => {
    const res = await axios.post("https://ncore.pro/login.php", `nev=${encodeURIComponent(u)}&pass=${encodeURIComponent(p)}&ne_leptessen_ki=1&submitted=1`, { headers: { "Content-Type": "application/x-www-form-urlencoded" }, maxRedirects: 0, validateStatus: s => s < 400 });
    return res.headers["set-cookie"]?.map(c => c.split(';')[0]).join('; ') || "";
};

const scrapeNcore = async (q, type, cookie) => {
    const { data } = await axios.get(`https://ncore.pro/torrents.php?miben=${type==="imdb"?"imdb":"name"}&mire=${encodeURIComponent(q)}&kivalasztott_tipus=osszes_fit`, { headers: { Cookie: cookie } });
    const $ = cheerio.load(data), rows = [], seen = new Set(), key = data.match(/key=([a-zA-Z0-9]+)/i)?.[1] || "";
    $(".box_torrent, .box_torrent2").each((_, r) => {
        const $r = $(r), id = ($r.find('a[href*="id="]').attr('href') || "").match(/id=(\d+)/)?.[1];
        if (!id || seen.has(id)) return;
        const title = ($r.find('.torrent_txt a, .torrent_txt2 a, a[href*="action=details"]').first().attr('title') || $r.find('.torrent_txt a').text()).replace(/\[imdb:\s*[\d\.]+\]/gi, "").trim();
        if (!title) return;
        seen.add(id);
        rows.push({
            id, name: title, passkey: key, downloadUrl: `https://ncore.pro/torrents.php?action=download&id=${id}${key ? `&key=${key}` : ""}`,
            sizeStr: $r.find('.s_link_meret, div[class*="box_meret"]').text().trim() || ($r.text().match(/\d+(\.\d+)?\s*(B|KB|MB|GB|TB|GiB|MiB)/i)?.[0] || "N/A"),
            seeders: parseInt($r.find('.s_link_seed, div[class*="box_s"], a[href*="peers_s"]').text().trim()) || 0,
            cat: ($r.html().match(/tipus=([a-z0-9_]+)/i)?.[1]?.toLowerCase().endsWith("_hun") ? "HUN" : "ENG")
        });
    }); return rows;
};

const getTitle = async (t, id) => axios.get(`https://v3-cinemeta.strem.io/meta/${t}/${id}.json`, { timeout: 3000 }).then(r => r.data?.meta?.name).catch(() => null);
const isEpMatch = (t, s, e) => !s || !e || [new RegExp(`S0*${s}E0*${e}\\b`,'i'), new RegExp(`\\b${s}x0*${e}\\b`,'i'), new RegExp(`\\bE(P)?0*${e}\\b.*S0*${s}`,'i'), new RegExp(`S0*${s}\\b`,'i'), new RegExp(`\\b0*${s}\\.\\s*évad\\b`,'i')].some(p => p.test(t));
const isTitleMatch = (t, tgt) => { if (!tgt) return true; const w = sanitizeQ(tgt).toLowerCase().split(' ').filter(x => x.length > 2); return w.length <= 1 || w.filter(x => sanitizeQ(t).toLowerCase().includes(x)).length >= Math.min(2, w.length); };

const getStreams = async (type, fullId, cfg, host) => {
    if (!cfg?.ncore_user || !cfg?.torbox_key) return { streams: [] };
    const [imdbId, sStr, eStr] = fullId.split(':'), s = parseInt(sStr)||0, e = parseInt(eStr)||0;
    try {
        const cookie = await getSession(cfg.ncore_user, cfg.ncore_pass);
        let rows = await scrapeNcore(imdbId, "imdb", cookie);
        if (!rows.length && imdbId.startsWith("tt")) rows = await scrapeNcore(imdbId.replace("tt",""), "imdb", cookie);
        let title = null;
        if (!rows.length) {
            title = await getTitle(type, imdbId);
            if (title) for (const q of [title, title.split(":")[1]?.trim(), title.split(":")[0]?.trim(), sanitizeQ(title)]) if (q && !rows.length) rows = await scrapeNcore(q, "name", cookie);
        }
        const matched = rows.filter(t => (type==="series" && s ? isEpMatch(t.name, s, e) : (type==="movie" && title ? isTitleMatch(t.name, title) : true))).slice(0, 10);
        
        const torrents = await Promise.all(matched.map(async t => {
            try { return { ...t, hash: extractHash(Buffer.from((await axios.get(t.downloadUrl, { responseType: 'arraybuffer', timeout: 4000, headers: { Cookie: cookie } })).data)) }; } catch(err) { return { ...t, hash: null }; }
        }));
        
        const hashes = torrents.map(t => t.hash).filter(Boolean), cached = new Set();
        if (hashes.length) {
            try {
                const { data } = await axios.get(`https://api.torbox.app/v1/api/torrents/checkcached?hash=${hashes.join(",")}&format=object`, { headers: { Authorization: `Bearer ${cfg.torbox_key}` } });
                Object.entries(data?.data || {}).forEach(([h, v]) => { if (v) cached.add(h.toLowerCase()); });
                if (Array.isArray(data?.data)) data.data.forEach(i => cached.add((i.hash || i).toLowerCase()));
            } catch(err) {}
        }
        
        const streams = torrents.map(t => {
            const isC = t.hash && cached.has(t.hash.toLowerCase());
            return {
                name: `nCore + TorBox${isC ? " ⚡" : ""}`,
                title: `${isC ? "⚡ [CACHED]" : "⏳ [UNCACHED]"} ${detectLang(t.name, t.cat)}\n${t.name}\n💾 ${t.sizeStr} | 👤 ${t.seeders} seeds`,
                url: `https://${host}/resolve-ncore/${encodeURIComponent(JSON.stringify(cfg))}/${t.id}/${s}/${e}/${t.passkey||"none"}`
            };
        });
        
        // Restore perfect cached vs uncached sorting
        return { streams: [...streams.filter(s => s.name.includes("⚡")), ...streams.filter(s => !s.name.includes("⚡"))] };
    } catch (err) { return { streams: [] }; }
};

app.get("/resolve-ncore/:cfg/:id/:s/:e/:pk", async (req, res) => {
    try {
        const cfg = JSON.parse(decodeURIComponent(req.params.cfg)), { id, s, e } = req.params, pk = req.params.pk !== "none" ? `&key=${req.params.pk}` : "";
        autoCleanup(cfg.torbox_key).catch(()=>{});
        const cookie = await getSession(cfg.ncore_user, cfg.ncore_pass);
        const buf = (await axios.get(`https://ncore.pro/torrents.php?action=download&id=${id}${pk}`, { responseType: 'arraybuffer', headers: { Cookie: cookie }})).data;
        const form = new FormData(); form.append("file", Buffer.from(buf), { filename: `t_${id}.torrent`, contentType: "application/x-bittorrent" }); form.append("seed", "2");
        const tbAdd = await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent", form, { headers: { ...form.getHeaders(), Authorization: `Bearer ${cfg.torbox_key}` }});
        if (tbAdd.data?.success) {
            const tbId = tbAdd.data.data.torrent_id;
            const { data } = await axios.get(`https://api.torbox.app/v1/api/torrents/mylist?id=${tbId}`, { headers: { Authorization: `Bearer ${cfg.torbox_key}` }});
            const tData = Array.isArray(data?.data) ? data.data.find(t => t.id === tbId) || data.data[0] : data?.data;
            const { data: dl } = await axios.get(`https://api.torbox.app/v1/api/torrents/requestdl?torrent_id=${tbId}&file_id=${findTargetFile(tData?.files, s, e)}&token=${cfg.torbox_key}`, { headers: { Authorization: `Bearer ${cfg.torbox_key}` }});
            if (dl?.success) return res.redirect(302, dl.data);
        }
        res.status(500).send("TorBox processing failed.");
    } catch (err) { res.status(500).send("Resolve error."); }
});

app.get("/cleanup/:key", async (req, res) => { await autoCleanup(req.params.key); res.send("Cleanup OK"); });

app.get("/", (req, res) => res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>nCore+TorBox</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-slate-900 text-gray-200 flex items-center justify-center min-h-screen p-4"><div class="max-w-md w-full bg-slate-800 p-6 rounded-xl shadow-2xl border border-slate-700"><h1 class="text-2xl font-bold mb-2">nCore + TorBox</h1><p class="text-slate-400 text-sm mb-6">Enter credentials for your setup link.</p><form id="f" class="space-y-4"><div><label class="block text-sm mb-1">Username</label><input type="text" id="u" class="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded text-white" required></div><div><label class="block text-sm mb-1">Password</label><input type="password" id="p" class="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded text-white" required></div><div><label class="block text-sm mb-1">TorBox API Key</label><input type="password" id="k" class="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded text-white" required></div><button type="submit" class="w-full bg-blue-600 py-2 rounded font-semibold mt-4">Generate Link</button></form><div id="i" class="hidden mt-6 pt-6 border-t border-slate-700"><input type="text" id="m" readonly class="w-full text-xs p-2 bg-slate-900 border border-slate-700 text-slate-300 rounded mb-3"><a id="b" href="#" class="block w-full bg-green-600 text-white text-center font-bold py-3 rounded">Install to Stremio</a></div></div><script>document.getElementById('f').onsubmit=e=>{e.preventDefault();const c=encodeURIComponent(JSON.stringify({ncore_user:u.value.trim(),ncore_pass:p.value.trim(),torbox_key:k.value.trim()})), h=window.location.host;m.value="https://"+h+"/"+c+"/manifest.json";b.href="stremio://"+h+"/"+c+"/manifest.json";i.classList.remove('hidden');}</script></body></html>`));

const builder = new addonBuilder({ id: "org.nuvio.ncore.torbox", version: "2.9.1", name: "nCore + TorBox", description: "nCore via TorBox (Optimized Core)", catalogs: [], resources: ["stream"], types: ["movie", "series"], idPrefixes: ["tt"], behaviorHints: { configurable: true, configurationRequired: true } });
builder.defineStreamHandler(a => getStreams(a.type, a.id, a.config, a.extra?.host || "127.0.0.1:7001"));
app.get(["/manifest.json", "/:config/manifest.json"], (req, res) => res.json(builder.getInterface().manifest));
app.get("/:config/stream/:type/:id", async (req, res) => {
    try { res.json(await getStreams(req.params.type, req.params.id.replace(".json",""), JSON.parse(decodeURIComponent(req.params.config)), req.headers.host)); } 
    catch (e) { res.json({ streams: [] }); }
});

app.listen(PORT, () => console.log(`nCore Addon v2.9.1 active on port ${PORT}`));
