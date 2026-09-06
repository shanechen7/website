// api/getOrders.js

module.exports = async (req, res) => {
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
        const tokenRes = await fetch(`${SEATABLE_URL}/api/v2.1/dtable/app-access-token/`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json; charset=utf-8; indent=4',
                'Authorization': `Bearer ${API_TOKEN}`
            }
        });

        if (!tokenRes.ok) {
            return res.status(401).json({ error: "SeaTable API Token 鉴权失败" });
        }

        const tokenData = await tokenRes.json();
        const { dtable_uuid, access_token } = tokenData;

        const tableName = encodeURIComponent(code);
        const rowsRes = await fetch(
            `${SEATABLE_URL}/api-gateway/api/v2/dtables/${dtable_uuid}/rows/?table_name=${tableName}&limit=1000`,
            {
                headers: {
                    'Authorization': `Token ${access_token}`,
                    'Accept': 'application/json; charset=utf-8; indent=4'
                }
            }
        );

        if (!rowsRes.ok) {
            return res.status(404).json({ error: "未找到该客户子表，请检查子表名是否与客户代码完全一致" });
        }

        const seaTableData = await rowsRes.json();
        const rawRows = seaTableData.rows || [];

        // 数据格式转换
        const frontendOrders = rawRows.map((row, index) => {
            // 【关键修复】从 row.fields 里面获取列数据
            const fields = row.fields || {}; 
            
            return {
                id: row._id || index,
                name: fields['Name'] || '',
                billNo: fields['B/L（提单号）'] || '',
                containerNo: fields['CTNR（箱号）'] || '',
                volume: fields['C/V（货量）'] || '',
                statusKey: fields['State（状态）'] || 'sailing',
                transportType: fields['S/M（运输方式）'] || '',
                lastMileCarrier: fields['后端派送方式'] || '',
                lastMileTrackingNo: fields['后端单号'] || '',
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
};
