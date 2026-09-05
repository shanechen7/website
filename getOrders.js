// api/getOrders.js

// Vercel 会默认执行这个 handler 函数
export default async function handler(req, res) {
    // 1. 获取前端传来的参数 (比如前端用 /api/getOrders?code=TEST001 访问)
    const { code } = req.query;

    // 2. 验证参数（模拟你的逻辑）
    if (!code) {
        return res.status(400).json({ error: "缺少客户代码" });
    }

    // 3. 这里就是你以后写 Airtable 查询和飞驼 API 查询的地方
    // 现在我们先造点假数据返回
    if (code === 'TEST001') {
        const mockData = [
            { id: 1, billNo: 'COSCO6789012345', status: 'sailing', vessel: '测试船只' }
        ];
        // 4. 把数据以 JSON 格式返回给前端
        return res.status(200).json(mockData);
    } else {
        return res.status(404).json({ error: "客户不存在" });
    }
}