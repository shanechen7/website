// lib/freightower.js —— 飞驼开放平台封装
// 文档：https://doc.freightower.com
//
// ⚠️ 飞驼存在两种接入模式，用环境变量 FREIGHTOWER_MODE 切换：
//   plain  = 明文 Bearer 模式（OpenAPI 里写的那种，直连 /application/v1/query）
//   secure = 加密签名模式（加 /api/v1/exchange 前缀 + 签名头 + AES-256-CBC 加解密）
// 两种模式都实现了，拿到账号后问飞驼客服确认用哪种即可。

const crypto = require('crypto');

const BASE = (process.env.FREIGHTOWER_BASE || 'https://openapi.freightower.com').replace(/\/$/, '');
const MODE = (process.env.FREIGHTOWER_MODE || 'plain').toLowerCase(); // plain | secure
const PREFIX = '/api/v1/exchange';

const CLIENT_ID = process.env.FREIGHTOWER_CLIENT_ID;      // 取 token 用（有 clientId+secret 时才需要）
const CLIENT_SECRET = process.env.FREIGHTOWER_SECRET;     // 取 token 用
const API_KEY = process.env.FREIGHTOWER_API_KEY;          // 线上标准版只给一个 API Key 时，直接当 Bearer 用
const APP_ID = process.env.FREIGHTOWER_APP_ID;            // 签名用
const APP_SECRET = process.env.FREIGHTOWER_APP_SECRET;    // 签名用
const DATA_SECRET = process.env.FREIGHTOWER_DATA_SECRET;  // AES 密钥

// ============================================================
// 工具
// ============================================================
const b64url = (buf) => Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlDecode = (str) => Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// AES-256-CBC 需要 32 字节密钥：
// 若 data_secret 不是 32 字节，则用 SHA-256 派生（飞驼若给了 32 位字符串则直接用）
function getAesKey() {
    if (!DATA_SECRET) throw new Error('缺少 FREIGHTOWER_DATA_SECRET');
    const raw = Buffer.from(DATA_SECRET, 'utf8');
    return raw.length === 32 ? raw : crypto.createHash('sha256').update(raw).digest();
}

function encryptBody(plainText) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', getAesKey(), iv);
    const enc = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    return { data: b64url(enc), iv: b64url(iv) };
}

function decryptBody(data, iv) {
    const decipher = crypto.createDecipheriv('aes-256-cbc', getAesKey(), b64urlDecode(iv));
    const dec = Buffer.concat([decipher.update(b64urlDecode(data)), decipher.final()]);
    return dec.toString('utf8');
}

// 签名：SHA256(AppId + 时间戳(毫秒) + AppSecret + 业务字符串) -> 小写 hex
function makeSign(timestamp, bizString) {
    return crypto.createHash('sha256')
        .update(`${APP_ID}${timestamp}${APP_SECRET}${bizString}`, 'utf8')
        .digest('hex');
}

// ============================================================
// Token：有效期 24 小时，这里 12 小时主动刷新；业务接口返回 40100 时强制刷新
// ============================================================
let tokenCache = { token: null, expireAt: 0 };

async function getToken(force = false) {
    if (!force && tokenCache.token && Date.now() < tokenCache.expireAt) {
        return tokenCache.token;
    }
    if (!CLIENT_ID || !CLIENT_SECRET) {
        throw new Error('缺少 FREIGHTOWER_CLIENT_ID / FREIGHTOWER_SECRET');
    }

    const path = '/auth/api/token';
    const url = BASE + (MODE === 'secure' ? PREFIX : '') + path;
    const rawBody = JSON.stringify({ clientId: CLIENT_ID, secret: CLIENT_SECRET });

    // Token 接口：需要签名头，但【不需要加密】也【不需要 Authorization】
    const ts = String(Date.now());
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (MODE === 'secure') {
        if (!APP_ID || !APP_SECRET) throw new Error('缺少 FREIGHTOWER_APP_ID / FREIGHTOWER_APP_SECRET');
        headers['X-Auth-AppId'] = APP_ID;
        headers['X-Auth-Timestamp'] = ts;
        headers['X-Auth-Sign'] = makeSign(ts, rawBody);
    }

    const res = await fetch(url, { method: 'POST', headers, body: rawBody });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) throw new Error('获取 Token 失败');

    // 文档示例里 token 在 data.access_token，schema 里也列了顶层 access_token，两种都兼容
    const token = (json.data && json.data.access_token) || json.access_token;
    if (!token) throw new Error('飞驼未返回 access_token：' + JSON.stringify(json).slice(0, 200));

    tokenCache = { token, expireAt: Date.now() + 12 * 60 * 60 * 1000 };
    return token;
}

// ============================================================
// 统一请求：自动加签名/加密/解密，40100 自动刷新 token 重试一次
// ============================================================
// 有独立 API Key 就直接当 Bearer 用（标准版常见），否则用 clientId+secret 换 token
async function getAuthToken() {
    return API_KEY ? API_KEY : getToken();
}

async function request(path, { method = 'POST', body = null, retry = true } = {}) {
    const token = await getAuthToken();
    const url = BASE + (MODE === 'secure' ? PREFIX : '') + path;
    const rawBody = body ? JSON.stringify(body) : '';

    let sendBody = rawBody || undefined;
    let signTarget = rawBody;
    if (MODE === 'secure') {
        const enc = encryptBody(rawBody);
        sendBody = JSON.stringify({ data: enc.data, iv: enc.iv });
        // 签名对象：默认按【最终发送的报文】；若飞驼要求按原始明文，设 FREIGHTOWER_SIGN_TARGET=plain
        signTarget = process.env.FREIGHTOWER_SIGN_TARGET === 'plain' ? rawBody : sendBody;
    }

    const ts = String(Date.now());
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (MODE === 'secure') {
        headers['X-Auth-AppId'] = APP_ID;
        headers['X-Auth-Timestamp'] = ts;
        headers['X-Auth-Sign'] = makeSign(ts, signTarget);
    }
    headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(url, { method, headers, body: sendBody });
    const resJson = await res.json().catch(() => null);

    // 40100 = 鉴权失败/签名错误/解密失败 -> 刷新 token 重试一次
    if (resJson && resJson.statusCode === 40100 && retry && !API_KEY) {
        await getToken(true);
        return request(path, { method, body, retry: false });
    }

    // secure 模式：响应体也是加密的，需要解密后再解析
    if (MODE === 'secure' && resJson && resJson.data && resJson.iv) {
        const plain = decryptBody(resJson.data, resJson.iv);
        return JSON.parse(plain);
    }
    return resJson;
}

// ============================================================
// 节点码 -> 前端三段状态（sailing / port / arrived / none）
// 来源：飞驼《集装箱综合跟踪-节点状态码》
// ============================================================
const SAILING = ['LOBD', 'DLPT', 'TSBA', 'TSCA', 'TSDC', 'TSLB', 'TSDP', 'FDLB', 'FDDP', 'BGLB', 'BGDP'];
const PORT = ['BDAR', 'POCA', 'DSCH', 'FDBA', 'FDDC', 'BGBA', 'BGDC'];
const ARRIVED = ['PCAB', 'STCS', 'STRP', 'RCVE', 'FETA', 'GWIT', 'GTOT', 'IRDS'];
const ALERT = ['DUMP', 'CUIP', 'SRHD', 'TMHD', 'SRSD'];

function mapState(statusCategory, eventCode) {
    const code = String(eventCode || '').toUpperCase();
    if (ARRIVED.includes(code)) return 'arrived';
    if (PORT.includes(code)) return 'port';
    if (SAILING.includes(code)) return 'sailing';
    switch (String(statusCategory || '').toUpperCase()) {
        case 'COMPLETE': return 'arrived';
        case 'PROCESS':
        case 'START': return 'sailing';
        case 'NODATA':
        case 'ABNORMAL': return 'none';
        default: return 'sailing';
    }
}

// ============================================================
// 海运：集装箱综合跟踪（订阅+查询）
// POST /application/v1/query
// ============================================================
async function trackContainer({ billNo, containerNo, carrierCode, businessNo }) {
    // 没买"自动识别船司"，carrierCode 必须来自表格人工维护，不能传 AUTO
    if (!carrierCode) {
        return { ok: false, message: '缺少船司代码：请在 SeaTable 表格的「船司代码」列填写（如 MSC / OOCL / COSU）' };
    }

    // 按箱计费（5元/箱）：
    //   不传 containerNo 时，返回结果里的 containers[] 会包含该票下所有箱，只发起一次请求；
    //   只有确实要单箱数据（用于过滤）时才传 containerNo。
    const payload = {
        billNo: billNo || '',
        containerNo: containerNo || '',
        carrierCode,
        billCategory: 'BL',            // 固定提单号类型，避免同一单号被重复订阅重复扣费
        businessNo: businessNo || '',  // 不允许 # & ? / 四种符号
    };

    const json = await request('/application/v1/query', { method: 'POST', body: payload });
    if (!json || json.statusCode !== 20000) {
        return { ok: false, statusCode: json && json.statusCode, message: json && json.message };
    }

    const r = (json.data && json.data.result) || {};
    const cs = r.currentStatus || {};
    const receipt = r.receipt || {};
    const delivery = r.delivery || {};
    const fv = r.firstVessel || {};
    const containers = r.containers || [];
    const events = (containers[0] && containers[0].status) || [];

    return {
        ok: true,
        billNo: r.billNo || billNo || '',
        containerNo: r.containerNo || containerNo || '',
        carrier: (r.carrier && (r.carrier.nameCn || r.carrier.code)) || '',
        // 一票多箱：这里把该票下所有箱都带出来，前端可以逐箱展示（只查一次，不额外扣费）
        totalContainers: (r.booking && r.booking.totalContainers) || '',
        containers: containers.map((c) => ({
            no: c.containerNo || '',
            type: c.containerTypeGroup || c.containerType || '',
            status: c.currentStatusDescriptionCn || '',
            statusCode: c.currentStatusCode || '',
            place: c.eventPlace || '',
        })),
        vessel: fv.vessel || cs.vslName || '',
        voyage: fv.voyage || cs.voy || '',
        pol: receipt.name || receipt.nameOrigin || '',
        pod: delivery.name || delivery.nameOrigin || '',
        polCode: receipt.code || '',
        podCode: delivery.code || '',
        etd: receipt.etd || receipt.std || '',
        atd: receipt.atd || '',
        eta: delivery.eta || delivery.sta || '',
        ata: delivery.ata || '',
        statusCategory: r.statusCategory || '',
        statusText: cs.descriptionCn || r.statusDescription || '',
        statusCode: cs.eventCode || '',
        stateKey: mapState(r.statusCategory, cs.eventCode),
        alert: ALERT.includes(String(cs.eventCode || '').toUpperCase()),
        endTime: r.endTime || '',
        updateTime: r.updateTime || '',
        traces: events.map((e) => ({
            code: e.eventCode || '',
            text: e.descriptionCn || e.descriptionEn || '',
            time: e.eventTime || '',
            place: e.eventPlace || '',
            estimated: e.isEsti === 'Y',
        })),
    };
}

// ============================================================
// 快递：DDP 派送段（UPS / FedEx / DHL ...）
//   订阅 POST /application/express/subscribe（仅支持单票）
//   查询 GET  /application/express/observer?businessNumber=xxx
// ============================================================
async function queryExpress(businessNumber) {
    const path = `/application/express/observer?businessNumber=${encodeURIComponent(businessNumber)}`;
    const json = await request(path, { method: 'GET' });
    if (!json || json.statusCode !== 20000 || !Array.isArray(json.data) || json.data.length === 0) {
        return null;
    }
    const d = json.data[0];
    const dest = d.destination_info || d.origin_info || {};
    const trackinfo = dest.trackinfo || [];
    return {
        ok: true,
        trackingNo: d.tracking_number || businessNumber,
        courierCode: d.courier_code || '',
        deliveryStatus: d.delivery_status || '',
        statusInfo: d.status_info || d.latest_event || '',
        latestTime: d.latest_checkpoint_time || '',
        signedBy: d.signed_by || '',
        updating: d.updating !== false,
        traces: trackinfo.map((t) => ({
            code: t.checkpoint_delivery_status || '',
            text: t.tracking_detail || '',
            time: t.checkpoint_date || '',
            place: [t.city, t.state, t.country_iso2].filter(Boolean).join(', '),
        })),
    };
}

async function trackExpress({ trackingNo, courierCode }) {
    if (!trackingNo) return { ok: false, message: '缺少派送单号' };

    // 先查，查不到再订阅（订阅可能计费，所以优先走查询）
    let info = await queryExpress(trackingNo);
    if (info) return info;

    if (!courierCode) return { ok: false, message: '派送单号暂无数据，且未配置快递商简码' };

    const sub = await request('/application/express/subscribe', {
        method: 'POST',
        body: { businessNumber: trackingNo, courierCode },
    });
    if (!sub || (sub.statusCode !== 20000 && sub.statusCode !== '物流单号已存在')) {
        return { ok: false, statusCode: sub && sub.statusCode, message: sub && sub.message };
    }
    // 订阅后稍等再查
    await new Promise((r) => setTimeout(r, 1500));
    info = await queryExpress(trackingNo);
    return info || { ok: false, message: '已订阅，暂未获取到轨迹' };
}

module.exports = { trackContainer, trackExpress, queryExpress, getToken, mapState };
