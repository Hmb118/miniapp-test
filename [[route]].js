/**
 * این تابع در Cloudflare Pages اجرا می‌شود.
 * وظیفه آن دریافت درخواست‌های /api از فرانت‌اند و ارسال مستقیم آن‌ها
 * به ورکر بک‌اند از طریق Service Binding است.
 * * نام متغیر Service Binding در اینجا 'BACKEND_SERVICE' فرض شده است.
 */

export async function onRequest(context) {
    // context.env.BACKEND_SERVICE اشاره دارد به سرویس بایندینگ متصل شده
    if (!context.env.BACKEND_SERVICE) {
      return new Response("Service Binding 'BACKEND_SERVICE' is not configured.", { status: 500 });
    }
  
    // ارسال درخواست اصلی دقیقا همانطور که هست به ورکر بک‌اند
    return context.env.BACKEND_SERVICE.fetch(context.request);
}