// api/getOrders.js

export default async function handler(req, res) {
    // 1. 接收前端传来的客户代码（也就是子表名，比如 41d2iaY8）
    const { code } = req.query;

    if (!code) {
        return res.status(400).json({ error: "缺少客户代码" });
    }

    // 2. 从 Vercel 环境变量里读取你的 API Token
    const SEATABLE_URL = 'https://cloud.seatable.cn';
    const API_TOKEN = process.env.SEATABLE_TOKEN; 

    if (!API_TOKEN) {
        return res.status(500).json({ error: "服务器未配置 SeaTable Token" });
    }

    try {
        // 3. 用 API Token 去换取临时的 Access Token 和 Base ID
        const tokenRes = await fetch(`${SEATABLE_URL}/api-gateway/api/v2/dtables/app-access-token/`, {
            method: 'POST',
            headers: {
                'Authorization': `Token ${API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (!tokenRes.ok) {
            return res.status(401).json({ error: "SeaTable API Token 无效，请检查环境变量" });
        }

        const tokenData = await tokenRes.json();
        const { dtable_uuid, access_token } = tokenData;

        // 4. 用换来的 access_token 和 dtable_uuid，去查询对应子表的数据
        const tableName = encodeURIComponent(code); // 客户代码就是子表名
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
            // 如果查不到，说明客户输入的代码在 SeaTable 里没有对应的子表
            return res.status(404).json({ error: "未找到该客户的运单数据或代码错误" });
        }

        const seaTableData = await rowsRes.json();
        const rawRows = seaTableData.rows || [];

        // 5. 数据格式转换：把 SeaTable 的中文列名，映射成前端网页认识的英文变量名
        const frontendOrders = rawRows.map((row, index) => {
            return {
                id: row._id || index,
                name: row['Name'] || '',
                billNo: row['B/L（提单号）'] || '',
                containerNo: row['CTNR（箱号）'] || '',
                volume: row['C/V（货量）'] || '',
                statusKey: row['State（状态）'] || 'sailing', // 如果没填状态，默认航行中
                transportType: row['S/M（运输方式）'] || '',
                lastMileCarrier: row['后端派送方式'] || '',
                lastMileTrackingNo: row['后端单号'] || '',
                
                // 下面这些是前端原本需要展示的字段，SeaTable 里暂时没建，先给空值防止网页报错
                vessel: '', 
                voyage: '',
                pol: '',
                pod: '',
                etd: '',
                eta: '',
                traces: [] 
            };
        });

        // 6. 把整理好的数据返回给前端网页
        return res.status(200).json(frontendOrders);

    } catch (error) {
        console.error('Server Error:', error);
        return res.status(500).json({ error: "服务器内部错误，请联系管理员" });
    }
}
