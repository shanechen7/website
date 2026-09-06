// api/getOrders.js

export default async function handler(req, res) {
    const { code } = req.query;

    if (!code) {
        return res.status(400).json({ error: "缺少客户代码" });
    }

    const SEATABLE_URL = 'https://cloud.seatable.cn';
    const API_TOKEN = process.env.SEATABLE_TOKEN; 

    if (!API_TOKEN) {
        return res.status(500).json({ error: "服务器未配置 SeaTable Token" });
    }

    try {
        // 【修改点】这里必须用 GET 方法去获取 Access Token
        const tokenRes = await fetch(`${SEATABLE_URL}/api-gateway/api/v2/dtables/app-access-token/`, {
            method: 'GET',
            headers: {
                'Authorization': `Token ${API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (!tokenRes.ok) {
            const errBody = await tokenRes.text();
            console.error("SeaTable Token 获取失败:", errBody);
            return res.status(401).json({ error: "SeaTable API Token 无效或未授权读取该表" });
        }

        const tokenData = await tokenRes.json();
        const { dtable_uuid, access_token } = tokenData;

        // 查询对应子表的数据
        const tableName = encodeURIComponent(code);
        const rowsRes = await fetch(
            `${SEATABLE_URL}/api-gateway/api/v2/dtables/${dtable_uuid}/rows/?table_name=${tableName}&limit=1000`,
            {
                headers: {
                    'Authorization': `Token ${access_token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!rowsRes.ok) {
            const errBody = await rowsRes.text();
            console.error("SeaTable 获取行失败:", errBody);
            return res.status(404).json({ error: "未找到该客户的运单数据或子表名不匹配" });
        }

        const seaTableData = await rowsRes.json();
        const rawRows = seaTableData.rows || [];

        // 数据格式转换
        const frontendOrders = rawRows.map((row, index) => {
            return {
                id: row._id || index,
                name: row['Name'] || '',
                billNo: row['B/L（提单号）'] || '',
                containerNo: row['CTNR（箱号）'] || '',
                volume: row['C/V（货量）'] || '',
                statusKey: row['State（状态）'] || 'sailing',
                transportType: row['S/M（运输方式）'] || '',
                lastMileCarrier: row['后端派送方式'] || '',
                lastMileTrackingNo: row['后端单号'] || '',
                vessel: '', 
                voyage: '',
                pol: '',
                pod: '',
                etd: '',
                eta: '',
                traces: [] 
            };
        });

        return res.status(200).json(frontendOrders);

    } catch (error) {
        console.error('Server Error:', error);
        return res.status(500).json({ error: "服务器内部错误，请联系管理员" });
    }
}
