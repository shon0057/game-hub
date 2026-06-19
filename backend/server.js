require('dotenv').config(); // 🌟 1. 優先啟動環境變數讀取器

const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();

// 🌟 2. 修正宣告：確保 PORT 在最上方宣告，避免報出 ReferenceError!
const PORT = process.env.PORT || 5000; 

app.use(cors()); // 原本的這行保留

// 🌟 終極解鎖：手動強行塞入 CORS Headers，專治 Vercel 各种阻擋
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // 處理瀏覽器預檢請求 (Preflight Request)
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json()); // 原本的這行保留
app.use(express.json());

// 🔐 3. 全新 Base64 安全解碼與初始化邏輯
if (!process.env.FIREBASE_BASE64) {
  console.error("❌ 錯誤：找不到環境變數 FIREBASE_BASE64！請確認 .env 檔案內容是否正確。");
  process.exit(1);
}

try {
  // 🌟 把環境變數或 .env 裡的 Base64 密碼字串還原成原本的 JSON 物件
  const decodedKey = Buffer.from(process.env.FIREBASE_BASE64, 'base64').toString('utf8');
  const serviceAccount = JSON.parse(decodedKey);

  // 初始化 Firebase Admin
  initializeApp({
    credential: cert(serviceAccount)
  });
  console.log("🟢 [Firebase] 成功透過 Base64 安全解碼，並與 Firebase 雲端建立連線！");
} catch (err) {
  console.error("❌ [Firebase] 解碼 Base64 金鑰時發生錯誤：", err.message);
  process.exit(1);
}

const db = getFirestore();

// ==========================================
// 📡 路由 1：測試伺服器狀態
// ==========================================
app.get('/', (req, res) => {
  res.send('🎮 Gamer Hub 後端 API 正在雲端穩定運行中...');
});

// ==========================================
// 📡 路由 2：【新增或更新願望】(POST)
// ==========================================
app.post('/api/wishlist', async (req, res) => {
  try {
    const { userId, gameId, gameName, coverUrl, targetPrice, currentPrice } = req.body;

    if (!userId || !gameId || targetPrice === undefined) {
      return res.status(400).json({ success: false, message: "欄位資料不齊全" });
    }

    const priceTarget = parseFloat(targetPrice);
    const existingWishes = await db.collection('wishlists')
                                    .where('userId', '==', userId)
                                    .where('gameId', '==', gameId)
                                    .get();

    if (!existingWishes.empty) {
      const docId = existingWishes.docs[0].id;
      await db.collection('wishlists').doc(docId).update({
        targetPrice: priceTarget,
        currentPrice: parseFloat(currentPrice) || 0,
        updatedAt: new Date()
      });

      return res.json({
        success: true,
        message: `🔄 已更新 【${gameName}】 的期望追蹤價格為 $${priceTarget}！`
      });
    }

    const wishData = {
      userId,
      gameId,
      gameName,
      coverUrl: coverUrl || '',
      targetPrice: priceTarget,
      currentPrice: parseFloat(currentPrice) || 0,
      isNotified: false,
      createdAt: new Date()
    };

    const docRef = await db.collection('wishlists').add(wishData);
    res.json({ success: true, message: "🚀 願望已成功加入追蹤清單！", id: docRef.id });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 📡 路由 3：【取得某位使用者的所有願望】 (GET)
// ==========================================
app.get('/api/wishlist/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const snapshot = await db.collection('wishlists').where('userId', '==', userId).get();

    if (snapshot.empty) {
      return res.json({ success: true, data: [] });
    }

    const myWishes = [];
    snapshot.forEach(doc => {
      myWishes.push({ id: doc.id, ...doc.data() });
    });

    res.json({ success: true, data: myWishes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 📡 路由 4：【移除願望】 (DELETE)
// ==========================================
app.delete('/api/wishlist/:id', async (req, res) => {
  try {
    const docId = req.params.id;
    await db.collection('wishlists').doc(docId).delete();
    res.json({ success: true, message: "🗑️ 該遊戲已從願望清單中移除！" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// === 引入自動化定時套件 ===
const cron = require('node-cron');
const axios = require('axios');

// ==========================================
// ⏰ 降價追蹤機器人排程 (每隔 30 秒自動執行)
// ==========================================
cron.schedule('*/30 * * * * *', async () => {
  console.log('🤖 [機器人任務] 檢查時間到！正在巡邏所有玩家的願望清單...');
  try {
    const snapshot = await db.collection('wishlists').get();
    if (snapshot.empty) return;

    snapshot.forEach(async (doc) => {
      const wish = doc.data();
      const docId = doc.id;
      const searchUrl = `https://www.cheapshark.com/api/1.0/games?title=${encodeURIComponent(wish.gameName)}`;
      const searchRes = await axios.get(searchUrl);
      
      if (searchRes.data && searchRes.data.length > 0) {
        const latestPrice = parseFloat(searchRes.data[0].cheapest);
        await db.collection('wishlists').doc(docId).update({ currentPrice: latestPrice });

        if (latestPrice <= wish.targetPrice) {
          if (!wish.isNotified) {
            console.log(`\n🚨🚨🚨【降價大警報！】 【${wish.gameName}】特價 $${latestPrice}！`);
            await db.collection('wishlists').doc(docId).update({ isNotified: true });
          }
        } else {
          if (wish.isNotified) await db.collection('wishlists').doc(docId).update({ isNotified: false });
        }
      }
    });
  } catch (error) {
    console.error('🤖 機器人排程錯誤:', error.message);
  }
});

// 🌟 4. 關鍵兼容：如果是 Vercel 雲端環境，不需要也不可以執行 listen 阻擋連線
// 🌟 刪除原本的 app.listen 區塊，換成這段 Vercel 與本機智慧雙軌匯出：
if (process.env.VERCEL) {
  module.exports = app; // 🌐 雲端環境：把 Express 導出給 Vercel 託管
} else {
  app.listen(PORT, () => { // 🟢 本機環境：依然能用 nodemon 正常跑 5000 端口
    console.log(`=========================================`);
    console.log(`🚀 Gamer Hub 本地端後端開機成功！Port: ${PORT}`);
    console.log(`=========================================`);
  });
}