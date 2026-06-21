require('dotenv').config(); // 🌟 1. 優先啟動環境變數讀取器

const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const nodemailer = require('nodemailer'); // 📧 引入郵件發送套件
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 5000; 

app.use(cors());

// 🌟 終極解鎖：手動強行塞入 CORS Headers，專治 Vercel 各种阻擋
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// 🔐 3. 全新 Base64 安全解碼與初始化邏輯
if (!process.env.FIREBASE_BASE64) {
  console.error("❌ 錯誤：找不到環境變數 FIREBASE_BASE64！");
  process.exit(1);
}

try {
  const decodedKey = Buffer.from(process.env.FIREBASE_BASE64, 'base64').toString('utf8');
  const serviceAccount = JSON.parse(decodedKey);

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
    // 🌟 核心升級：請前端多傳入 userEmail，這樣降價時後端才知道要把信寄給誰！
    // 🔍 同時解構大寫和小寫的 Email，防止前端打錯字或沒傳對
const { userId, gameId, gameName, coverUrl, targetPrice, currentPrice, storeId } = req.body;
const userEmail = req.body.userEmail || req.body.userEMail || "";

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
        userEmail: userEmail || existingWishes.docs[0].data().userEmail || "", // 更新時也順便同步 Email
        storeId: storeId || "1",
        updatedAt: new Date()
      });

      return res.json({
        success: true,
        message: `🔄 已更新 【${gameName}】 的期望追蹤價格為 $${priceTarget}！`
      });
    }

    const wishData = {
      userId,
      userEmail: userEmail || "", // 🔒 存入玩家信箱，供發信機器人讀取
      gameId,
      gameName,
      coverUrl: coverUrl || '',
      targetPrice: priceTarget,
      currentPrice: parseFloat(currentPrice) || 0,
      storeId: storeId || "1", 
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


// ====================================================
// 📧 核心發信與比價引擎函數 (抽出來供 本地端排程 與 Vercel 排程 同步共用)
// ====================================================
async function checkPricesAndSendEmailsLogic() {
  console.log('🤖 [機器人任務] 檢查時間到！正在巡邏所有玩家的願望清單並核對降價郵件...');
  
  // 1. 初始化郵件發送器（從環境變數讀取你的發信箱帳密）
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER, 
      pass: process.env.EMAIL_PASS  
    }
  });

  const snapshot = await db.collection('wishlists').get();
  if (snapshot.empty) {
    console.log('ℹ️ 目前資料庫中沒有任何玩家追蹤遊戲。');
    return;
  }

  // 遍歷所有願望清單進行 CheapShark 比價
  for (const doc of snapshot.docs) {
    const wish = doc.data();
    const docId = doc.id;
    
    try {
      const searchUrl = `https://www.cheapshark.com/api/1.0/games?title=${encodeURIComponent(wish.gameName)}`;
      const searchRes = await axios.get(searchUrl);
      
      if (searchRes.data && searchRes.data.length > 0) {
        const latestPrice = parseFloat(searchRes.data[0].cheapest);
        
        // 更新當前最新價格
        await db.collection('wishlists').doc(docId).update({ currentPrice: latestPrice });

        // 觸發降價條件
        if (latestPrice <= wish.targetPrice) {
          if (!wish.isNotified) {
            console.log(`🚨【降價警報】${wish.gameName} 特價 $${latestPrice}！期望價：$${wish.targetPrice}`);

            // 📬 如果該筆願望有存電子郵件，則執行發信
            if (wish.userEmail && wish.userEmail.includes('@')) {
              const mailOptions = {
                from: `"Gamer Hub 降價追蹤守護者" <${process.env.EMAIL_USER}>`,
                to: wish.userEmail,
                subject: `🔥 降價大驚喜！您追蹤的《${wish.gameName}》已經降到期望價格囉！`,
                html: `
                  <div style="font-family: sans-serif; padding: 25px; background: #0f172a; color: #fff; border-radius: 12px; max-width: 500px; box-shadow: 0 4px 10px rgba(0,0,0,0.3);">
                    <h2 style="color: #06b6d4; border-bottom: 2px solid #1e293b; padding-bottom: 10px; margin-top:0;">🎮 Gamer Hub 降價特報</h2>
                    <p>親愛的玩家您好：</p>
                    <p>特大好消息！您在願望清單中苦苦守候的遊戲 <strong>《${wish.name || wish.gameName}》</strong> 降價啦！</p>
                    <div style="background: #1e293b; padding: 15px; border-radius: 8px; margin: 20px 0;">
                      <p style="margin: 5px 0;">💰 <strong>當前最低特價：</strong> <span style="color: #22c55e; font-size: 1.3rem; font-weight: bold;">$${latestPrice}</span></p>
                      <p style="margin: 5px 0;">🎯 <strong>您的期望價格：</strong> $${wish.targetPrice}</p>
                    </div>
                    <p>趕快登入您的 Gamer Hub 查看，或直接前往特價商店搶購吧！🚀</p>
                    <hr style="border: 0; border-top: 1px solid #1e293b; margin: 20px 0;">
                    <small style="color: #64748b;">本信件由 Gamer Hub 雲端排程自動發送，請勿直接回信。</small>
                  </div>
                `
              };

              await transporter.sendMail(mailOptions);
              console.log(`📧 降價通知信已順利送達：${wish.userEmail}`);
            }

            // 標記為已通知，防止重複轟炸信箱
            await db.collection('wishlists').doc(docId).update({ isNotified: true });
          }
        } else {
          // 如果價格回彈高於期望價，把通知開關重設回 false，等下次降價才能再收到信
          if (wish.isNotified) {
            await db.collection('wishlists').doc(docId).update({ isNotified: false });
          }
        }
      }
    } catch (singleErr) {
      console.error(`❌ 處理單筆遊戲 [${wish.gameName}] 時發生錯誤:`, singleErr.message);
    }
  }
}

// ==========================================
// 📡 路由 5：【對接 Vercel 定時任務的 API 節點】(GET)
// ==========================================
app.get('/api/check-prices-and-send-email', async (req, res) => {
  try {
    console.log("⏰ 收到 Vercel Cron 排程發出的比價發信請求！");
    await checkPricesAndSendEmailsLogic();
    res.status(200).json({ success: true, message: "Vercel 雲端排程比價與郵件發送程序執行完畢！" });
  } catch (error) {
    console.error("Vercel 排程執行失敗:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ⏰ 本地端排程補償 (只有在本地用 nodemon 跑時，每隔 30 秒會執行)
// ==========================================
if (!process.env.VERCEL) {
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await checkPricesAndSendEmailsLogic();
    } catch (err) {
      console.error('🤖 本地端排程巡邏錯誤:', err.message);
    }
  });
}

// 🌟 智慧雙軌匯出：
if (process.env.VERCEL) {
  module.exports = app; 
} else {
  app.listen(PORT, () => { 
    console.log(`=========================================`);
    console.log(`🚀 Gamer Hub 本地端後端開機成功！Port: ${PORT}`);
    console.log(`=========================================`);
  });
}
