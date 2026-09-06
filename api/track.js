// api/track.js —— Vercel Serverless Function
// 输入提单号/箱号（+可选派送单号），调用飞驼查询海运轨迹与派送轨迹
// 前端在拿到 SeaTable 列表后，对每一票单独调用本接口（并发控制在 3~5 个）

const { trackContainer, trackExpress } = require('../lib/freightower');

// ============================================================
// 简单内存缓存（Serverless 实例复用期间有效）
// 计费按单号订阅，不是按次，所以缓存主要用于加速 + 防限流
// ============================================================
const cache = new Map();          // key -> { value, expireAt }
const inflight = new Map();       // key -> Promise（防同一单号并发重复请求）

const HOUR = 60 * 60 * 1000;
const TTL_ACTIVE = 6 * HOUR;      // 在途：6 小时
const TTL_DONE = 7 * 24 * HOUR;   // 已完成/已签收：7 天

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expireAt) {
        cache.delete(key);
        return null;
    }
    return hit.value;
}

function cacheSet(key, value, ttl) {
    // 简单防内存膨胀
    if (cache.size > 500) {
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
    }
    cache.set(key, { value, expireAt: Date.now() + ttl });
}

const isFinished = (r) => {
    if (!r || !r.ok) return false;
    if (r.stateKey === 'arrived') return true;
    if (r.endTime) {
        const t = Date.parse(String(r.endTime).replace(/\//g, '-'));
        if (!isNaN(t) && t < Date.now()) return true;
    }
    return false;
};

module.exports = async (req, res) => {
    const {
        billNo = '',
        containerNo = '',
        carrier = '',          // 船司代码，可留空走 AUTO
        express = '',          // 派送方式：UPS / FedEx ...
        expressNo = '',        // 派送单号
        courierCode = '',      // 飞驼快递商简码（可选，未传时只查询不订阅）
        debug,
    } = req.query;

    if (!billNo && !containerNo) {
        return res.status(400).json({ error: '缺少提单号或箱号' });
    }

    // 缓存 key 只按"提单号 + 船司"，不带上箱号：
    // 同一票不管前端传哪个箱号，都只发一次请求，避免按箱重复扣费（5元/箱）
    const seaKey = `sea:${String(billNo || containerNo).toUpperCase()}|${String(carrier).toUpperCase()}`;

    try {
        // ---- 1. 海运段（带缓存 + 并发去重）----
        let sea = cacheGet(seaKey);
        let fromCache = !!sea;

        if (!sea) {
            if (inflight.has(seaKey)) {
                sea = await inflight.get(seaKey);
                fromCache = true;
            } else {
                const p = (async () => {
                    try {
                        // 优先提单号；失败/无数据再退回箱号
                        let r = billNo
                            ? await trackContainer({ billNo, containerNo: '', carrierCode: carrier, businessNo: '' })
                            : { ok: false };
                        if (!r.ok && containerNo) {
                            r = await trackContainer({ billNo: '', containerNo, carrierCode: carrier, businessNo: '' });
                        }
                        return r;
                    } finally {
                        inflight.delete(seaKey);
                    }
                })();
                inflight.set(seaKey, p);
                sea = await p;
                if (sea && sea.ok) {
                    cacheSet(seaKey, sea, isFinished(sea) ? TTL_DONE : TTL_ACTIVE);
                } else if (sea && sea.pending) {
                    // 订阅成功但数据还没抓到：只缓存 1 分钟，稍后会自动重试
                    cacheSet(seaKey, sea, 60 * 1000);
                }
            }
        }

        // ---- 2. 派送段 ----
        // 飞驼标准版未开通国际快递（UPS/FedEx）权限，默认不查询，
        // 派送信息以 SeaTable 表格里人工维护的「后端派送方式 / 后端单号」为准。
        // 以后若接入别的快递 API，只要传 courierCode 就会自动启用。
        let lastMile = null;
        let lastMileNote = null;
        if (expressNo && courierCode) {
            const exKey = `exp:${expressNo}`;
            lastMile = cacheGet(exKey);
            if (!lastMile) {
                lastMile = await trackExpress({ trackingNo: expressNo, courierCode });
                if (lastMile && lastMile.ok) {
                    const done = /签收|delivered/i.test(
                        `${lastMile.deliveryStatus || ''} ${lastMile.statusInfo || ''}`
                    );
                    cacheSet(exKey, lastMile, done ? TTL_DONE : TTL_ACTIVE);
                }
            }
        } else if (expressNo) {
            lastMileNote = '派送段暂未接入自动查询，以表格维护的信息为准';
        }

        const body = {
            ok: true,
            sea: sea && sea.ok ? sea : null,
            seaError: sea && !sea.ok ? (sea.message || '暂无数据') : null,
            pending: !!(sea && sea.pending),
            lastMile: lastMile && lastMile.ok ? lastMile : null,
            lastMileError: lastMile && !lastMile.ok ? (lastMile.message || '暂无数据') : null,
            lastMileNote,
            cached: fromCache,
            fetchedAt: new Date().toISOString(),
        };

        if (debug === '1') {
            body.rawSea = sea;
            body.rawLastMile = lastMile;
        }

        return res.status(200).json(body);

    } catch (error) {
        console.error('[track] Error:', error);
        return res.status(500).json({
            error: '轨迹查询失败：' + (error && error.message ? error.message : String(error)),
        });
    }
};
