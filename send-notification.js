// functions/send-notification.js
// এডমিন প্যানেল থেকে POST রিকোয়েস্ট এলে এই ফাংশন:
// ১. Firestore এর "notifications" কালেকশনে সেভ করে (in-app ইনবক্সের জন্য)
// ২. "fcm_tokens" কালেকশনে সেভ থাকা সব ডিভাইসে আসল পুশ নোটিফিকেশন পাঠায়
// ৩. যেসব টোকেন আর কাজ করে না (ইউজার আনইনস্টল/পারমিশন বন্ধ করেছে) সেগুলো Firestore থেকে মুছে ফেলে

const admin = require('firebase-admin');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
    });
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch (e) {
        return { statusCode: 400, body: 'Invalid JSON' };
    }

    const { title, message, secret } = body;

    // সিক্রেট কী মিলিয়ে দেখা হচ্ছে, যাতে যে কেউ এই লিংক দিয়ে স্প্যাম পাঠাতে না পারে
    if (secret !== process.env.ADMIN_SECRET) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
    if (!title || !message) {
        return { statusCode: 400, body: JSON.stringify({ error: 'title and message are required' }) };
    }

    const db = admin.firestore();

    // ১. in-app ইনবক্সের জন্য Firestore এ সেভ (আগে থেকে যেভাবে কাজ করত)
    await db.collection('notifications').add({
        title,
        message,
        time: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ২. সব সেভ করা ডিভাইস টোকেন বের করা
    const tokensSnap = await db.collection('fcm_tokens').get();
    const tokens = tokensSnap.docs.map((doc) => doc.id);

    if (tokens.length === 0) {
        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, sent: 0, note: 'কোনো ডিভাইস টোকেন পাওয়া যায়নি' }),
        };
    }

    // FCM একবারে সর্বোচ্চ ৫০০ টোকেনে পাঠাতে পারে, তাই ব্যাচে ভাগ করা হচ্ছে
    const chunks = [];
    for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500));

    let successCount = 0, failureCount = 0;
    const invalidTokens = [];

    for (const chunk of chunks) {
        const response = await admin.messaging().sendEachForMulticast({
            notification: { title, body: message },
            tokens: chunk,
        });
        successCount += response.successCount;
        failureCount += response.failureCount;
        response.responses.forEach((res, idx) => {
            if (!res.success) {
                const code = res.error && res.error.code;
                if (
                    code === 'messaging/invalid-registration-token' ||
                    code === 'messaging/registration-token-not-registered'
                ) {
                    invalidTokens.push(chunk[idx]);
                }
            }
        });
    }

    // ৩. অকেজো টোকেন পরিষ্কার করা
    await Promise.all(invalidTokens.map((t) => db.collection('fcm_tokens').doc(t).delete()));

    return {
        statusCode: 200,
        body: JSON.stringify({ success: true, sent: successCount, failed: failureCount }),
    };
};
