require('dotenv').config(); // 🌟 啟動環境變數讀取器
const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
// 🌟 宣告 PORT 變數，優先讀取環境變數，讀不到則預設使用 5000
const PORT = process.env.PORT || 5000; 

app.use(cors());
app.use(express.json());

// 🔐 全新 Base64 安全解碼與初始化邏輯（取代舊的實體檔案偵測）
if (!process.env.FIREBASE_BASE64) {
  console.error("❌ 錯誤：找不到環境變數 FIREBASE_BASE64！請確認 .env 檔案內容是否正確。");
  process.exit(1);
}

try {
  // 🌟 把 .env 裡的 Base64 密碼字串還原成原本的 JSON 物件
  const decodedKey = Buffer.from(process.env.FIREBASE_BASE64, 'base64').toString('utf8');
  const serviceAccount = JSON.parse(decodedKey);

  // 初始化 Firebase Admin
  initializeApp({
    credential: cert(serviceAccount)
  });
  console.log("🟢 [Firebase] 成功透過 Base64 安全解碼，並與 Firebase 雲端建立連線！");
} catch (err) {
  console.error("❌ [Firebase] 解碼 Base64 金鑰時發生錯誤，請確認你的 Base64 字串是否完整：", err.message);
  process.exit(1);
}

const db = getFirestore();

// ==========================================
// 📡 路由 1：測試伺服器狀態
// ==========================================
app.get('/', (req, res) => {
  res.send('🎮 Gamer Hub 後端 API 正在穩定運行中...');
});

// ==========================================
// 📡 路由 2：【新增或更新願望】(POST) - 防重複升級版
// ==========================================
app.post('/api/wishlist', async (req, res) => {
  try {
    const { userId, gameId, gameName, coverUrl, targetPrice, currentPrice } = req.body;

    if (!userId || !gameId || targetPrice === undefined) {
      return res.status(400).json({ success: false, message: "欄位資料不齊全" });
    }

    const priceTarget = parseFloat(targetPrice);

    // 🔍 1. 先去資料庫查看看，這個使用者是不是已經追蹤過這款遊戲了？
    const existingWishes = await db.collection('wishlists')
                                    .where('userId', '==', userId)
                                    .where('gameId', '==', gameId)
                                    .get();

    // 🔄 2. 如果已經存在，就直接更新心理價，不重複新增！
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

    // ➕ 3. 如果是新遊戲，執行新增邏輯
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

    res.json({
      success: true,
      message: "🚀 願望已成功加入追蹤清單！",
      id: docRef.id
    });
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
    const snapshot = await db.collection('wishlists')
                            .where('userId', '==', userId)
                            .get();

    if (snapshot.empty) {
      return res.json({ success: true, data: [] });
    }

    const myWishes = [];
    snapshot.forEach(doc => {
      myWishes.push({
        id: doc.id,
        ...doc.data()
      });
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
    console.error("刪除失敗原因:", error); 
    res.status(500).json({ success: false, message: error.message });
  }
});

// === 引入自動化定時套件 ===
const cron = require('node-cron');
const axios = require('axios');

// ==========================================
// ⏰ 降價追蹤機器人排程 (Cron Job - 每隔 30 秒自動執行)
// ==========================================
cron.schedule('*/30 * * * * *', async () => {
  console.log('🤖 [機器人任務] 檢查時間到！正在從雲端撈取所有玩家的願望清單...');

  try {
    const snapshot = await db.collection('wishlists').get();
    
    if (snapshot.empty) {
      console.log('🤖 [機器人任務] 目前資料庫沒有任何追蹤願望，收工！');
      return;
    }

    snapshot.forEach(async (doc) => {
      const wish = doc.data();
      const docId = doc.id;

      console.log(`🔍 正在檢查遊戲：【${wish.gameName}】...`);

      const searchUrl = `https://www.cheapshark.com/api/1.0/games?title=${encodeURIComponent(wish.gameName)}`;
      const searchRes = await axios.get(searchUrl);
      
      if (searchRes.data && searchRes.data.length > 0) {
        const latestPrice = parseFloat(searchRes.data[0].cheapest);
        console.log(`   -> 💰 雲端記錄目前最低價: $${latestPrice} (玩家心理價: $${wish.targetPrice})`);

        await db.collection('wishlists').doc(docId).update({
          currentPrice: latestPrice
        });

        if (latestPrice <= wish.targetPrice) {
          if (!wish.isNotified) {
            console.log(`\n🚨🚨🚨【降價大警報！】🚨🚨🚨`);
            console.log(`🎮 遊戲：【${wish.gameName}】降價啦！`);
            console.log(`🎯 玩家心理期望價：$${wish.targetPrice}`);
            console.log(`🔥 當前瘋狂特惠價：$${latestPrice}`);
            console.log(`📬 [系統訊息] 已成功對用戶 ${wish.userId} 發出降價通知郵件！`);
            console.log(`==================================\n`);

            await db.collection('wishlists').doc(docId).update({
              isNotified: true
            });
          } else {
            console.log(`   -> 🔔 雖然低於心理價，但之前已經通知過囉！`);
          }
        } else {
          if (wish.isNotified) {
            await db.collection('wishlists').doc(docId).update({
              isNotified: false
            });
          }
          console.log(`   -> ❌ 還不夠便宜，繼續潛伏守候...`);
        }
      }
    });

  } catch (error) {
    console.error('🤖 [機器人任務] 執行時發生錯誤:', error.message);
  }
});

// 🌟 使用我們在最上面定義好的 PORT 變數啟動監聽
app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`🚀 Gamer Hub 後端核心 API 組件裝配完成！`);
  console.log(`🔗 監聽端口：http://localhost:${PORT}`);
  console.log(`=========================================`);
});
