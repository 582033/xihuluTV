const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname + "/data/", 'db.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin"; 

const cache = new NodeCache({ stdTTL: 1800, checkperiod: 600 }); // 全局缓存，默认半小时过期
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ sites: [], config: { tmdb_api_key: "", tmdb_proxy: "https://api.tmdb.org" } }, null, 2));
}

function getDB() { 
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE));
        return { sites: data.sites || [], config: data.config || { tmdb_api_key: "", tmdb_proxy: "https://api.tmdb.org" } };
    } catch(e) {
        return { sites: [], config: { tmdb_api_key: "", tmdb_proxy: "https://api.tmdb.org" } };
    }
}
function saveDB(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

// === 原开放配置获取接口 ===
app.get('/api/config', (req, res) => {
    const db = getDB();
    const activeSitesCount = db.sites ? db.sites.filter(s => s.active).length : 0;
    res.json({ ...db.config, hasSites: activeSitesCount > 0 });
});

// === ★ 新增：真实测速接口 ★ ===
app.get('/api/check', async (req, res) => {
    const { key } = req.query;
    const sites = getDB().sites;
    const site = sites.find(s => s.key === key);
    
    if (!site) return res.json({ latency: 9999 });

    const start = Date.now();
    try {
        // 尝试请求该接口的首页（只请求一页，极简模式）
        await axios.get(`${site.api}?ac=list&pg=1`, { timeout: 3000 });
        const latency = Date.now() - start;
        res.json({ latency: latency });
    } catch (e) {
        res.json({ latency: 9999 }); // 超时或错误
    }
});

// === 热门接口 ===
app.get('/api/hot', async (req, res) => {
    const sites = getDB().sites.filter(s => ['ffzy', 'bfzy', 'lzi', 'dbzy'].includes(s.key));
    for (const site of sites) {
        try {
            const response = await axios.get(`${site.api}?ac=list&pg=1&h=24&out=json`, { timeout: 3000 });
            const list = response.data.list || response.data.data;
            if(list && list.length > 0) return res.json({ list: list.slice(0, 12) });
        } catch (e) { continue; }
    }
    res.json({ list: [] });
});

// === 搜索接口 (加入缓存机制提升性能) ===
app.get('/api/search', async (req, res) => {
    const { wd } = req.query;
    console.log(`[Search] ${wd}`);
    if (!wd) return res.json({ list: [] });
    
    const cacheKey = `search_${wd}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        console.log(`[Search-Cache] Hit: ${wd}`);
        return res.json({ list: cachedData });
    }
    
    const sites = getDB().sites.filter(s => s.active);
    
    const promises = sites.map(async (site) => {
        try {
            const response = await axios.get(`${site.api}?ac=list&wd=${encodeURIComponent(wd)}&out=json`, { timeout: 6000 });
            const data = response.data;
            const list = data.list || data.data;
            if (list && Array.isArray(list)) {
                return list.map(item => ({
                    ...item, 
                    site_key: site.key, 
                    site_name: site.name,
                    // 这里先不测速，给个默认值，点击详情再测
                    latency: 0 
                }));
            }
        } catch (e) {}
        return [];
    });
    
    const results = await Promise.all(promises);
    const finalData = results.flat();
    
    if (finalData.length > 0) {
        cache.set(cacheKey, finalData); // 仅在有结果时缓存
    }
    res.json({ list: finalData });
});

// === 详情接口 ===
app.get('/api/detail', async (req, res) => {
    const { site_key, id } = req.query;
    const targetSite = getDB().sites.find(s => s.key === site_key);
    if (!targetSite) return res.status(404).json({ error: "Site not found" });
    try {
        const response = await axios.get(`${targetSite.api}?ac=detail&ids=${id}&out=json`, { timeout: 6000 });
        res.json(response.data);
    } catch (e) { res.status(500).json({ error: "Source Error" }); }
});

app.post('/api/admin/login', (req, res) => req.body.password === ADMIN_PASSWORD ? res.json({ success: true }) : res.status(403).json({ success: false }));
app.get('/api/admin/sites', (req, res) => res.json(getDB().sites));
app.post('/api/admin/sites', (req, res) => { 
    const current = getDB();
    current.sites = req.body.sites;
    saveDB(current); 
    res.json({ success: true }); 
});
app.get('/api/admin/config', (req, res) => res.json(getDB().config));
app.post('/api/admin/config', (req, res) => {
    const current = getDB();
    current.config = req.body.config;
    saveDB(current);
    res.json({ success: true });
});

app.listen(PORT, () => { console.log(`服务已启动: http://localhost:${PORT}`); });
