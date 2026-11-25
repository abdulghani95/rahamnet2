# رهام نت – دليل التشغيل من الجوال

## 1) Firebase (مجاني – فقط لتوصيل الإشعارات لأندرويد)
1. افتح console.firebase.google.com ← Add project.
2. Add app ← Android ← اسم الحزمة: `com.rahamnet.app` ← حمّل `google-services.json`.
3. Project settings ← Service accounts ← Generate new private key (ملف JSON للسيرفر).

## 2) السيرفر
ارفع المشروع على GitHub ثم انشر مجلد `server` على Railway أو Fly.io أو VPS (يُفضّل Dockerfile).
المتغيرات:
- `OWNER_KEY` = رمز صاحب العمل (6 أحرف فأكثر)
- `FIREBASE_SERVICE_ACCOUNT` = محتوى ملف الـprivate key كاملاً
- `DATA_DIR` = `/data` مع ربط Volume دائم على `/data`
اختبر: `https://عنوانك/health` يجب أن يُظهر `"push":true`.
تنبيه: الخطط المجانية بدون قرص دائم تفقد البيانات عند إعادة التشغيل.

## 3) أسرار GitHub (Settings ← Secrets and variables ← Actions)
- `API_URL` = عنوان السيرفر بـ https بدون / في النهاية
- `GOOGLE_SERVICES_JSON` = محتوى google-services.json كاملاً
- `KEYSTORE_B64` = النص الموجود في ملف KEYSTORE_B64.txt (يجعل كل نسخة جديدة تُثبَّت فوق القديمة). احتفظ به سرياً.

## 4) بناء الـAPK
- Actions ← Build Android APK ← Run workflow، أو
- Releases ← Create a new release ← tag جديد مثل `v1.0` ← Publish. بعد عدة دقائق يظهر RahamNet.apk داخل الإصدار مباشرة.

## 5) التثبيت
حمّل الـAPK وافتحه واسمح بالتثبيت من مصدر غير معروف.
