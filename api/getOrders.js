// api/getOrders.js —— Vercel Serverless Function
// 读取 SeaTable 中"以客户代码命名的子表"的行数据，并转换为前端展示格式
// 调试：浏览器访问 /api/getOrders?code=你的代码&debug=1 可查看 SeaTable 真实返回的列名

module.exports = async (req, res) => {
    const { code } = req.query;
    const debug = req.query.debug === '1';

    if (!code) {
        return res.status(400).json({ error: '缺少客户代码' });
    }

    const SEATABLE_URL = (process.env.SEATABLE_URL || 'https://cloud.seatable.cn').replace(/\/$/, '');
    const API_TOKEN = process.env.SEATABLE_TOKEN;

    if (!API_TOKEN) {
        return res.status(500).json({ error: '服务器未配置 SeaTable Token（环境变量 SEATABLE_TOKEN）' });
    }

    // ============================================================
    // 工具：宽容的列名查找
    // 1) 先精确匹配；2) 再忽略 括号/空格/大小写 后匹配。
    // 这样即使 SeaTable 里实际是 "B/L(提单号)"（半角括号）也能取到值。
    // ============================================================
    const norm = (s) => String(s == null ? '' : s)
        .replace(/[\s()（）[\]【】/／\\,，。:：;；-]/g, '')
        .toLowerCase();

    const getCol = (row, ...names) => {
        if (!row) return null;
        // 1) 精确匹配（按顺序，第一个命中的返回）
        for (const n of names) {
            const v = row[n];
            if (v !== undefined && v !== null && v !== '') return v;
        }
        // 2) 模糊匹配（忽略括号、空格、大小写）
        const keys = Object.keys(row);
        for (const n of names) {
            const key = keys.find((k) => norm(k) === norm(n));
            if (key) {
                const v = row[key];
                if (v !== undefined && v !== null && v !== '') return v;
            }
        }
        return null;
    };

    // 把 SeaTable 里可能的中文/英文状态值 -> 前端的三个状态 key
    const normalizeStatus = (v) => {
        if (!v) return 'sailing';
        const s = String(v).trim();
        if (s === 'sailing' || s === 'port' || s === 'arrived') return s;
        if (/到达|抵达|已到|arriv|complet/i.test(s)) return 'arrived';
        if (/进港|靠港|到港|port/i.test(s)) return 'port';
        // 其余一律视为"航行中/在途"
        return 'sailing';
    };

    // 根据已有数据拼出 5 个物流节点的时间线
    const buildTraces = (info) => {
        const stepMap = { in_warehouse: 0, departed: 1, sailing: 2, in_port: 3, arrived: 4 };
        const cur = stepMap[info.statusKey] == null ? 2 : stepMap[info.statusKey];
        const nodes = [
            { key: 'in_warehouse', time: '', location: '' },
            { key: 'departed', time: info.etd || '', location: info.pol || '' },
            { key: 'sailing', time: '', location: (info.vessel && info.voyage) ? `${info.vessel} / ${info.voyage}` : '' },
            { key: 'in_port', time: '', location: info.pod || '' },
            { key: 'arrived', time: info.eta || '', location: info.pod || '' },
        ];
        return nodes.map((n, i) => ({
            key: n.key,
            time: n.time || '',
            location: n.location || '',
            done: i <= cur,
            current: i === cur,
        }));
    };

    try {
        // ============================================================
        // 1. 获取 Base 的访问凭证（官方 v2.1 接口，Bearer 鉴权）
        // ============================================================
        const tokenRes = await fetch(`${SEATABLE_URL}/api/v2.1/dtable/app-access-token/`, {
            method: 'GET',
            headers: {
                Accept: 'application/json; charset=utf-8; indent=4',
                Authorization: `Bearer ${API_TOKEN}`,
            },
        });

        if (!tokenRes.ok) {
            const body = await tokenRes.text();
            console.error('[SeaTable] Token 获取失败:', tokenRes.status, body);
            return res.status(502).json({ error: 'SeaTable API Token 鉴权失败，请检查环境变量 SEATABLE_TOKEN' });
        }

        const tokenData = await tokenRes.json();
        const { dtable_uuid, access_token, dtable_server } = tokenData;
        if (!dtable_uuid || !access_token) {
            return res.status(502).json({ error: 'SeaTable 未返回 access_token / dtable_uuid' });
        }

        // ============================================================
        // 2. 查询该子表的行
        //    优先使用 token 接口返回的 dtable_server，失败再退回 api-gateway
        //    鉴权头按官方文档用 Bearer；个别老版本兼容 Token（自动重试一次）
        // ============================================================
        const tableQ = `table_name=${encodeURIComponent(code)}&limit=1000`;
        const server = (dtable_server || SEATABLE_URL).replace(/\/$/, '');
        const urlV1 = `${server}/api/v1/dtables/${dtable_uuid}/rows/?${tableQ}`;
        const urlGateway = `${SEATABLE_URL}/api-gateway/api/v2/dtables/${dtable_uuid}/rows/?${tableQ}`;

        const fetchRows = async (url) => {
            const makeReq = (authHeader) => fetch(url, {
                headers: {
                    Authorization: authHeader,
                    Accept: 'application/json; charset=utf-8; indent=4',
                },
            });
            const r1 = await makeReq(`Bearer ${access_token}`);
            if (r1.ok) return r1;
            if (r1.status === 401 || r1.status === 403) {
                const r2 = await makeReq(`Token ${access_token}`);
                if (r2.ok) return r2;
            }
            return r1;
        };

        let rowsRes = await fetchRows(urlV1);
        if (!rowsRes.ok) {
            const gw = await fetchRows(urlGateway);
            if (gw.ok) rowsRes = gw;
        }

        if (!rowsRes.ok) {
            const errBody = await rowsRes.text();
            console.error('[SeaTable] 行查询失败:', rowsRes.status, errBody);
            const isAuth = rowsRes.status === 401 || rowsRes.status === 403;
            return res.status(isAuth ? 502 : 404).json({
                error: isAuth
                    ? 'SeaTable 数据鉴权失败（status ' + rowsRes.status + '）'
                    : `未找到名为“${code}”的子表，或查询出错（status ${rowsRes.status}）`,
            });
        }

        const seaTableData = await rowsRes.json();
        const rawRows = seaTableData.rows || [];

        // ============================================================
        // 3. 列名 -> 前端字段 转换
        //    每个字段给多个候选列名（中/英文、带/不带括号），取第一个命中的
        // ============================================================
        const frontendOrders = rawRows.map((row, index) => {
            const rawStatus = getCol(row, 'State（状态）', 'State(状态)', '状态', 'State', 'Status');
            const statusKey = normalizeStatus(rawStatus);

            let vessel = getCol(row, '船名/航次', '船名航次', '船名', 'Vessel', 'vessel') || '';
            let voyage = getCol(row, '航次', 'Voyage', 'voyage') || '';
            // 兼容"船名/航次"合并在同一列的情况：自动拆成 船名 + 航次
            if (!voyage && vessel && /[/／]/.test(String(vessel))) {
                const parts = String(vessel).split(/[/／]/);
                vessel = (parts[0] || '').trim();
                voyage = parts.slice(1).join('/').trim();
            }

            const pol = getCol(row, '起运港', 'POL', 'Pol', '装货港', 'Port of Loading') || '';
            const pod = getCol(row, '目的港', 'POD', 'Pod', '卸货港', 'Port of Discharge') || '';
            const etd = getCol(row, 'ETD', '预计开船', '开船时间', '开船') || '';
            const eta = getCol(row, 'ETA', '预计到港', '到港时间', '到港') || '';

            const billNo = getCol(row, 'B/L（提单号）', 'B/L(提单号)', '提单号', 'Bill No', 'BillNo') || '';

            return {
                id: row._id || index,
                name: getCol(row, 'Name', '客户名称', '客户') || '',
                billNo,
                containerNo: getCol(row, 'CTNR（箱号）', 'CTNR(箱号)', '箱号', 'CTNR') || '',
                volume: getCol(row, 'C/V（货量）', 'C/V(货量)', '货量', 'Volume', 'C/V') ?? '',
                statusKey,
                statusRaw: rawStatus || '',
                transportType: getCol(row, 'S/M（运输方式）', 'S/M(运输方式)', '运输方式', 'S/M') || '',
                lastMileCarrier: getCol(row, '后端派送方式', '派送方式', 'Last-mile carrier') || '',
                lastMileTrackingNo: getCol(row, '后端单号', '派送单号', 'Last-mile tracking no') || '',
                vessel,
                voyage,
                pol,
                pod,
                etd,
                eta,
                traces: buildTraces({ vessel, voyage, pol, pod, etd, eta, statusKey }),
            };
        });

        // ============================================================
        // 4. 返回。带 debug=1 时附上 SeaTable 真实列名，方便排查
        // ============================================================
        if (debug) {
            const presentColumns = Array.from(new Set(rawRows.flatMap((r) => Object.keys(r))));
            return res.status(200).json({
                ok: true,
                count: rawRows.length,
                presentColumns,
                sample: rawRows[0] || null,
                orders: frontendOrders,
            });
        }

        return res.status(200).json(frontendOrders);

    } catch (error) {
        console.error('[SeaTable] Server Error:', error);
        return res.status(500).json({ error: '服务器内部错误：' + (error && error.message ? error.message : String(error)) });
    }
};
