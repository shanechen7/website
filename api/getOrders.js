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
    // SeaTable 行数据里用的是列的 key（短 ID，如 0000/M4g），不是列的显示名。
    // 这里先用 metadata 拿到 "列名 -> key" 的映射，再用 key 去取值。
    // 兼容：括号/空格/大小写、中英文候选名。
    // ============================================================
    let colNameToKey = {};   // 列显示名 -> 列 key
    let colKeyToName = {};   // 列 key -> 列显示名（仅 debug 用）
    let colKeyToOpt = {};    // 列 key -> { optionId: option文本 }（单选/多选列）

    const norm = (s) => String(s == null ? '' : s)
        .replace(/[\s()（）[\]【】/／\\,，。:：;；-]/g, '')
        .toLowerCase();

    // SeaTable 单选列在行数据里存的是"选项 id"而不是选项文字
    //（例如 State 选了"已交付"，接口可能返回一串编号）。
    // 这里用 metadata 的 options 把 id 还原成文字，避免匹配不到。
    const resolveCell = (key, v) => {
        if (v === undefined || v === null || v === '') return v;
        const opt = colKeyToOpt[key];
        if (opt && typeof v === 'string' && opt[v]) return opt[v];
        return v;
    };

    const getCol = (row, ...names) => {
        if (!row) return null;
        const colKeys = Object.keys(colNameToKey);

        // 1) 用 metadata 的 "列名 -> key" 映射取值（精确 + 模糊）
        for (const n of names) {
            if (colNameToKey[n]) {
                const v = row[colNameToKey[n]];
                if (v !== undefined && v !== null && v !== '') return resolveCell(colNameToKey[n], v);
            }
        }
        for (const n of names) {
            const matchedName = colKeys.find((k) => norm(k) === norm(n));
            if (matchedName && colNameToKey[matchedName]) {
                const v = row[colNameToKey[matchedName]];
                if (v !== undefined && v !== null && v !== '') return resolveCell(colNameToKey[matchedName], v);
            }
        }

        // 2) 兜底：直接按行里的 key 匹配（兼容 key 就是显示名的情况）
        for (const n of names) {
            const v = row[n];
            if (v !== undefined && v !== null && v !== '') return resolveCell(n, v);
        }
        const rowKeys = Object.keys(row);
        for (const n of names) {
            const key = rowKeys.find((k) => norm(k) === norm(n));
            if (key) {
                const v = row[key];
                if (v !== undefined && v !== null && v !== '') return resolveCell(key, v);
            }
        }
        return null;
    };

    // 把 SeaTable 里可能的中文/英文状态值 -> 前端的三个状态 key
    const normalizeStatus = (v) => {
        if (!v) return 'sailing';
        const s = String(v).trim();
        if (s === 'sailing' || s === 'port' || s === 'arrived') return s;
        // "已交付/已签收/妥投" = 私卡（或快递）派送完成，货代在 State 人工维护 -> 整单完成
        if (/到达|抵达|已到|已交付|已签收|签收|妥投|arriv|deliver|complet|sign/i.test(s)) return 'arrived';
        if (/进港|靠港|到港|port/i.test(s)) return 'port';
        // 其余一律视为"航行中/在途"
        return 'sailing';
    };

    // ============================================================
    // 带重试 + 报错定位的 fetch 封装：
    // 网络抖动/冷启动 DNS 慢时自动重试；多次失败则抛出带"网址+底层原因"的错误，
    // 方便在 Vercel 日志 / 前端弹窗里一眼看出是哪个 SeaTable 接口连不上。
    // ============================================================
    const seaFetch = async (label, url, init = {}) => {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                return await fetch(url, init);
            } catch (e) {
                if (attempt === 3) {
                    const cause = (e && e.cause && (e.cause.message || e.cause.code)) || '';
                    const msg = `请求失败(${label}): ${url}${cause ? ` —— ${cause}` : ''}`;
                    console.error('[SeaTable] ' + msg, e);
                    throw new Error(msg, { cause: e });
                }
                console.warn(`[SeaTable] ${label} 第 ${attempt} 次失败，稍后重试:`, url);
                await new Promise((r) => setTimeout(r, 600 * attempt));
            }
        }
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
        const tokenRes = await seaFetch('获取Base访问凭证 app-access-token', `${SEATABLE_URL}/api/v2.1/dtable/app-access-token/`, {
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
        // 2. 通用请求工具（Bearer 为主，兼容 Token）
        // ============================================================
        const fetchRows = async (url) => {
            const makeReq = (authHeader) => seaFetch('读取SeaTable数据', url, {
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

        // ============================================================
        // 3. 获取 Base 元数据：拿到"列名 -> key"的映射
        //    SeaTable 行数据里的键是列 key（如 0000/M4g），不是列显示名。
        // ============================================================
        const server = (dtable_server || SEATABLE_URL).replace(/\/$/, '');
        const metaV1 = `${server}/api/v1/dtables/${dtable_uuid}/metadata/`;
        const metaGateway = `${SEATABLE_URL}/api-gateway/api/v2/dtables/${dtable_uuid}/metadata/`;
        let metaRes = await fetchRows(metaV1);
        if (!metaRes.ok) {
            const gw = await fetchRows(metaGateway);
            if (gw.ok) metaRes = gw;
        }
        if (!metaRes.ok) {
            const errBody = await metaRes.text();
            console.error('[SeaTable] 元数据获取失败:', metaRes.status, errBody);
            return res.status(502).json({ error: '无法获取 SeaTable 子表结构（metadata），请检查 Token 权限' });
        }
        const metaData = await metaRes.json();
        const tables = metaData?.metadata?.tables || metaData?.tables || [];
        const targetTable = tables.find((t) => t.name === code);
        if (!targetTable) {
            return res.status(404).json({ error: `未找到名为"${code}"的子表，请检查客户代码` });
        }
        for (const col of (targetTable.columns || [])) {
            if (col.name && col.key) {
                colNameToKey[col.name] = col.key;
                colKeyToName[col.key] = col.name;
            }
            // 单选/多选列：行数据里存 option id，需还原成选项文字
            const opts = (col.data && col.data.options) || col.options;
            if (col.key && Array.isArray(opts)) {
                const map = {};
                for (const o of opts) {
                    if (o && o.id != null && o.name != null) map[String(o.id)] = String(o.name);
                }
                if (Object.keys(map).length) colKeyToOpt[col.key] = map;
            }
        }

        // ============================================================
        // 4. 查询该子表的行
        // ============================================================
        const tableQ = `table_name=${encodeURIComponent(code)}&limit=1000`;
        const rowsV1 = `${server}/api/v1/dtables/${dtable_uuid}/rows/?${tableQ}`;
        const rowsGateway = `${SEATABLE_URL}/api-gateway/api/v2/dtables/${dtable_uuid}/rows/?${tableQ}`;
        let rowsRes = await fetchRows(rowsV1);
        if (!rowsRes.ok) {
            const gw = await fetchRows(rowsGateway);
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
                // 船司代码：没买"自动识别船司"，必须靠表格里人工维护，查轨迹时必填
                carrierCode: getCol(row, '船司代码', '船公司代码', 'Carrier Code', 'Carrier', '船司', '船东', 'SCAC') || '',
                containerNo: getCol(row, 'CTNR（箱号）', 'CTNR(箱号)', '箱号', 'CTNR') || '',
                volume: getCol(row, 'C/V（货量）', 'C/V(货量)', '货量', 'Volume', 'C/V') ?? '',
                statusKey,
                statusRaw: rawStatus || '',
                // 交付方式（唯一列：D/M），用于判断"到门"还是"到港"：
                //   到门 = 以 DOOR 结尾（CY TO DOOR / CFS TO DOOR / DOOR TO DOOR）、ATD、International Express
                //   其余（CY TO CY / CFS TO CFS / DOOR TO CY / DOOR TO CFS / ATA 等）一律到港
                deliveryMode: getCol(row, 'D/M（交付方式）', 'D/M(交付方式)', 'D/M', '交付方式', 'Delivery Mode', 'DeliveryMode') || '',
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
        // 5. 返回。带 debug=1 时附上"列名 -> key"映射，方便排查
        // ============================================================
        if (debug) {
            const tableColumns = Object.entries(colNameToKey).map(([name, key]) => ({ key, name }));
            return res.status(200).json({
                ok: true,
                count: rawRows.length,
                tableName: code,
                tableColumns,
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
