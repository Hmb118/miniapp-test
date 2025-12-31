/**
 * Eitaa Quiz Pro Ultimate - Backend Worker
 * این ورکر فقط مسئولیت مدیریت API و دیتابیس KV را بر عهده دارد.
 * بخش UI حذف شده است چون توسط Cloudflare Pages سرو می‌شود.
 */

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // مدیریت درخواست‌های API
        if (url.pathname.startsWith('/api/')) {
            // بررسی اتصال KV
            if (!env.QUIZ_KV) {
                // اگر درخواست init بود و KV متصل نبود، پاسخ پیش‌فرض برای دمو
                if (url.pathname === '/api/init') {
                    return new Response(JSON.stringify({
                        registered: false,
                        isAdmin: true,
                        userData: { firstName: 'مدیر', lastName: 'سیستم', phone: '09120000000' },
                        quizzes: [],
                        history: [],
                        config: {},
                        isDemo: true
                    }), { headers: { "Content-Type": "application/json" } });
                }
                return new Response(
                    JSON.stringify({ error: "KV_NAMESPACE not bound" }),
                    { status: 500, headers: { "Content-Type": "application/json" } }
                );
            }
            return await handleApi(request, env);
        }

        // اگر درخواستی غیر از API به این ورکر برسد
        return new Response("Backend Worker is running. Access via API only.", { status: 404 });
    }
};

async function handleApi(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // هدرهای CORS برای اطمینان (هرچند با Service Binding روی یک دامین هستید)
    const corsHeaders = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const getBody = async () => { try { return await request.json(); } catch { return {}; } };

    try {
        if (path === '/api/init' && request.method === 'POST') {
            const body = await getBody();
            const userId = body.userId;
            const user = await env.QUIZ_KV.get(`user:${userId}`, { type: 'json' });
            const isAdmin = userId.toString() === env.ADMIN_EITAA_ID;
            
            const config = await env.QUIZ_KV.get('system:config', { type: 'json' }) || { 
                systemTitle: 'سامانه هوشمند مسابقات', announcement: '', headerImage: '', bgImage: ''
            };

            const list = await env.QUIZ_KV.list({ prefix: "quiz:" });
            const now = Date.now();
            const quizzes = [];
            const history = [];

            let totalUsers = 0;
            if (isAdmin) {
                const uList = await env.QUIZ_KV.list({ prefix: "user:" });
                totalUsers = uList.keys.length;
            }

            for (const key of list.keys) {
                const quiz = await env.QUIZ_KV.get(key.name, { type: 'json' });
                if (!quiz) continue;

                const submission = await env.QUIZ_KV.get(`sub:${quiz.id}:${userId}`, { type: 'json' });

                if (submission) {
                    history.push({
                        id: quiz.id,
                        title: quiz.title,
                        score: submission.score,
                        total: submission.total,
                        date: submission.submittedAt
                    });
                }

                const isExpired = quiz.endTime < now;
                const isFuture = quiz.startTime > now;

                if (isAdmin || !isFuture || submission) {
                    quiz.userStatus = submission ? 'submitted' : (isExpired ? 'expired' : 'active');
                    
                    if (quiz.winners) {
                        quiz.lotteryDone = true;
                        quiz.isWinner = quiz.winners.includes(userId);
                    } else {
                        quiz.lotteryDone = false;
                        quiz.isWinner = false;
                    }

                    if (!isAdmin && quiz.questions) {
                        quiz.questions = quiz.questions.map(q => {
                            const { correctAnswer, ...rest } = q;
                            return rest;
                        });
                    }
                    quizzes.push(quiz);
                }
            }

            return new Response(JSON.stringify({
                registered: !!user,
                userData: user || {},
                isAdmin,
                quizzes,
                history,
                config,
                meta: isAdmin ? { totalUsers, totalQuizzes: quizzes.length } : null
            }), { headers: corsHeaders });
        }

        if (path === '/api/register' && request.method === 'POST') {
            const body = await getBody();
            if (!body.userData.phone) return new Response(JSON.stringify({ error: "شماره تماس الزامی است" }), { status: 400, headers: corsHeaders });
            const existing = await env.QUIZ_KV.get(`user:${body.userId}`, { type: 'json' }) || {};
            const updated = { ...existing, ...body.userData };
            await env.QUIZ_KV.put(`user:${body.userId}`, JSON.stringify(updated));
            return new Response(JSON.stringify({ success: true, user: updated }), { headers: corsHeaders });
        }

        if (path === '/api/mark-read' && request.method === 'POST') {
            const body = await getBody();
            const key = `user:${body.userId}`;
            const user = await env.QUIZ_KV.get(key, { type: 'json' });
            if (user?.messages) {
                user.messages.forEach(m => m.read = true);
                await env.QUIZ_KV.put(key, JSON.stringify(user));
            }
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        if (path === '/api/submit' && request.method === 'POST') {
            const body = await getBody();
            const { userId, quizId, answers } = body;

            if (await env.QUIZ_KV.get(`sub:${quizId}:${userId}`)) {
                return new Response(JSON.stringify({ error: "Duplicate submission" }), { status: 400, headers: corsHeaders });
            }

            const quiz = await env.QUIZ_KV.get(`quiz:${quizId}`, { type: 'json' });
            let score = 0;
            let totalPoints = 0;

            quiz.questions.forEach((q, i) => {
                const points = q.points !== undefined ? parseInt(q.points) : 1; 
                if (points > 0) totalPoints += points;
                if (q.type === 'text') return; 
                
                const u = answers[i]?.toString().trim().toLowerCase();
                const c = q.correctAnswer?.toString().trim().toLowerCase();
                if (u === c) score += points;
            });

            const subData = { userId, score, total: totalPoints, submittedAt: Date.now(), answers };
            await env.QUIZ_KV.put(`sub:${quizId}:${userId}`, JSON.stringify(subData));
            return new Response(JSON.stringify({ success: true, score, total: totalPoints }), { headers: corsHeaders });
        }

        // --- ADMIN APIs ---
        const checkAdmin = (body) => body.adminId.toString() === env.ADMIN_EITAA_ID;

        if (path === '/api/admin/save-config' && request.method === 'POST') {
            const body = await getBody();
            if (!checkAdmin(body)) return new Response("Forbidden", { status: 403 });
            await env.QUIZ_KV.put('system:config', JSON.stringify(body.config));
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        if (path === '/api/admin/update-score' && request.method === 'POST') {
            const body = await getBody();
            if (!checkAdmin(body)) return new Response("Forbidden", { status: 403 });
            const key = `sub:${body.quizId}:${body.userId}`;
            const sub = await env.QUIZ_KV.get(key, { type: 'json' });
            if (sub) {
                sub.score = body.newScore;
                await env.QUIZ_KV.put(key, JSON.stringify(sub));
                return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
            }
            return new Response(JSON.stringify({ error: "Submission not found" }), { status: 404, headers: corsHeaders });
        }

        if (path === '/api/admin/create-quiz' && request.method === 'POST') {
            const body = await getBody();
            if (!checkAdmin(body)) return new Response("Forbidden", { status: 403 });
            const id = body.quiz.id || Date.now().toString();
            const quizData = { ...body.quiz, id, promoted: body.quiz.promoted || false };
            await env.QUIZ_KV.put(`quiz:${id}`, JSON.stringify(quizData));
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }
        
        if (path === '/api/admin/toggle-promote' && request.method === 'POST') {
            const body = await getBody();
            if (!checkAdmin(body)) return new Response("Forbidden", { status: 403 });
            const quiz = await env.QUIZ_KV.get(`quiz:${body.quizId}`, { type: 'json' });
            if(quiz) {
                quiz.promoted = body.promoted;
                await env.QUIZ_KV.put(`quiz:${body.quizId}`, JSON.stringify(quiz));
                return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
            }
            return new Response(JSON.stringify({ error: "Quiz not found" }), { status: 404, headers: corsHeaders });
        }

        if (path === '/api/admin/delete-quiz' && request.method === 'POST') {
            const body = await getBody();
            if (!checkAdmin(body)) return new Response("Forbidden", { status: 403 });
            await env.QUIZ_KV.delete(`quiz:${body.quizId}`);
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        if (path === '/api/admin/save-lottery' && request.method === 'POST') {
            const body = await getBody();
            if (!checkAdmin(body)) return new Response("Forbidden", { status: 403 });
            
            const quiz = await env.QUIZ_KV.get(`quiz:${body.quizId}`, { type: 'json' });
            if (quiz) {
                quiz.winners = body.winnerIds || [];
                await env.QUIZ_KV.put(`quiz:${body.quizId}`, JSON.stringify(quiz));
                return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
            }
            return new Response(JSON.stringify({ error: "Quiz not found" }), { status: 404, headers: corsHeaders });
        }

        if (path === '/api/admin/reset-lottery' && request.method === 'POST') {
            const body = await getBody();
            if (!checkAdmin(body)) return new Response("Forbidden", { status: 403 });
            
            const quiz = await env.QUIZ_KV.get(`quiz:${body.quizId}`, { type: 'json' });
            if (quiz) {
                delete quiz.winners;
                await env.QUIZ_KV.put(`quiz:${body.quizId}`, JSON.stringify(quiz));
                return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
            }
            return new Response(JSON.stringify({ error: "Quiz not found" }), { status: 404, headers: corsHeaders });
        }

        if (path === '/api/admin/delete-submission' && request.method === 'POST') {
            const body = await getBody();
            if (!checkAdmin(body)) return new Response("Forbidden", { status: 403 });
            
            await env.QUIZ_KV.delete(`sub:${body.quizId}:${body.targetUserId}`);
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        if (path === '/api/admin/stats' && request.method === 'POST') {
            const body = await getBody();
            if (!checkAdmin(body)) return new Response("Forbidden", { status: 403 });

            const quiz = await env.QUIZ_KV.get(`quiz:${body.quizId}`, { type: 'json' });
            const list = await env.QUIZ_KV.list({ prefix: `sub:${body.quizId}:` });
            const participants = [];

            for (const key of list.keys) {
                const sub = await env.QUIZ_KV.get(key.name, { type: 'json' });
                const u = await env.QUIZ_KV.get(`user:${sub.userId}`, { type: 'json' });
                participants.push({
                    ...sub,
                    id: body.quizId,
                    userInfo: u || { firstName: 'ناشناس', lastName: '', phone: '---' }
                });
            }

            return new Response(JSON.stringify({
                participants,
                questions: quiz?.questions || [],
                id: quiz?.id,
                winners: quiz?.winners || []
            }), { headers: corsHeaders });
        }

        if (path === '/api/admin/get-users' && request.method === 'POST') {
            const body = await getBody();
            if (!checkAdmin(body)) return new Response("Forbidden", { status: 403 });
            const list = await env.QUIZ_KV.list({ prefix: "user:" });
            const users = [];
            for (const key of list.keys) {
                const u = await env.QUIZ_KV.get(key.name, { type: 'json' });
                users.push({ id: key.name.split(':')[1], ...u });
            }
            return new Response(JSON.stringify({ users }), { headers: corsHeaders });
        }

        if (path === '/api/admin/send-message' && request.method === 'POST') {
            const body = await getBody();
            if (!checkAdmin(body)) return new Response("Forbidden", { status: 403 });
            const ids = Array.isArray(body.targetUserId) ? body.targetUserId : [body.targetUserId];
            for (const uid of ids) {
                const key = `user:${uid}`;
                const u = await env.QUIZ_KV.get(key, { type: 'json' });
                if (u) {
                    u.messages = u.messages || [];
                    u.messages.unshift({ id: Date.now() + Math.random(), text: body.message, date: Date.now(), read: false });
                    await env.QUIZ_KV.put(key, JSON.stringify(u));
                }
            }
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        if (path === '/api/admin/delete-message' && request.method === 'POST') {
            const body = await getBody();
            if (!checkAdmin(body)) return new Response("Forbidden", { status: 403 });
            const key = `user:${body.targetUserId}`;
            const u = await env.QUIZ_KV.get(key, { type: 'json' });
            if (u?.messages) {
                u.messages = u.messages.filter(m => m.id !== body.messageId);
                await env.QUIZ_KV.put(key, JSON.stringify(u));
                return new Response(JSON.stringify({ success: true, messages: u.messages }), { headers: corsHeaders });
            }
            return new Response(JSON.stringify({ error: "Failed" }), { status: 400, headers: corsHeaders });
        }

        return new Response("Not Found", { status: 404, headers: corsHeaders });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
}