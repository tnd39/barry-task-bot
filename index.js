require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ASSIGNEE_ID = parseInt(process.env.ASSIGNEE_ID) || 152;
const BASE_URL = 'https://mpm.macusaone.com';

let SESSION_COOKIE = process.env.SESSION_COOKIE || '';
let XSRF_TOKEN = process.env.XSRF_TOKEN || '';
global.reminderChatId = null;
global.autoPick = false;
global.maxAutoPick = 5;
global.currentPickCount = 0;
global.excludeTypes = []; // loại task không muốn pick
global.knownTaskIds = new Set(); // track task đã thấy

const waitingForCookie = {};a
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function getHeaders() {
  return {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Content-Type': 'application/json',
    'X-XSRF-TOKEN': decodeURIComponent(XSRF_TOKEN),
    'X-Requested-With': 'XMLHttpRequest',
    'Cookie': `mpm-mac-usa-one-session=${SESSION_COOKIE}; XSRF-TOKEN=${XSRF_TOKEN}`,
    'Referer': `${BASE_URL}/tasks?assignee_id=${ASSIGNEE_ID}&tab=pool`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0'
  };
}

function refreshCookies(setCookieArr) {
  if (!setCookieArr) return;
  setCookieArr.forEach(c => {
    if (c.includes('mpm-mac-usa-one-session')) SESSION_COOKIE = c.split(';')[0].split('=').slice(1).join('=');
    if (c.includes('XSRF-TOKEN')) XSRF_TOKEN = c.split(';')[0].split('=').slice(1).join('=');
  });
}

// ===== API: POOL (đúng URL từ network) =====
async function getPoolTasks(dateFilter = null) {
  try {
    const url = `${BASE_URL}/api/v1/tasks/datatables?draw=1` +
      `&columns%5B0%5D%5Bdata%5D=&columns%5B0%5D%5Bname%5D=expand&columns%5B0%5D%5Bsearchable%5D=false&columns%5B0%5D%5Borderable%5D=false&columns%5B0%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B0%5D%5Bsearch%5D%5Bregex%5D=false` +
      `&columns%5B1%5D%5Bdata%5D=id&columns%5B1%5D%5Bname%5D=id&columns%5B1%5D%5Bsearchable%5D=false&columns%5B1%5D%5Borderable%5D=false` +
      `&columns%5B2%5D%5Bdata%5D=title&columns%5B2%5D%5Bname%5D=title&columns%5B2%5D%5Bsearchable%5D=true&columns%5B2%5D%5Borderable%5D=false` +
      `&columns%5B3%5D%5Bdata%5D=project&columns%5B3%5D%5Bname%5D=project&columns%5B3%5D%5Bsearchable%5D=false&columns%5B3%5D%5Borderable%5D=false` +
      `&columns%5B4%5D%5Bdata%5D=account_manager&columns%5B4%5D%5Bname%5D=account_manager&columns%5B4%5D%5Bsearchable%5D=false` +
      `&columns%5B5%5D%5Bdata%5D=task_type&columns%5B5%5D%5Bname%5D=task_type&columns%5B5%5D%5Bsearchable%5D=false` +
      `&columns%5B6%5D%5Bdata%5D=status&columns%5B6%5D%5Bname%5D=status&columns%5B6%5D%5Bsearchable%5D=false` +
      `&columns%5B7%5D%5Bdata%5D=subtasks_summary&columns%5B7%5D%5Bname%5D=subtasks&columns%5B7%5D%5Bsearchable%5D=false` +
      `&columns%5B8%5D%5Bdata%5D=deadline&columns%5B8%5D%5Bname%5D=deadline&columns%5B8%5D%5Bsearchable%5D=false&columns%5B8%5D%5Borderable%5D=true` +
      `&columns%5B9%5D%5Bdata%5D=created_at&columns%5B9%5D%5Bname%5D=created_at&columns%5B9%5D%5Bsearchable%5D=false` +
      `&columns%5B10%5D%5Bdata%5D=updated_at&columns%5B10%5D%5Bname%5D=updated_at&columns%5B10%5D%5Bsearchable%5D=false&columns%5B10%5D%5Borderable%5D=true` +
      `&columns%5B11%5D%5Bdata%5D=created_by&columns%5B11%5D%5Bname%5D=created_by&columns%5B11%5D%5Bsearchable%5D=false` +
      `&columns%5B12%5D%5Bdata%5D=assignees&columns%5B12%5D%5Bname%5D=assignees&columns%5B12%5D%5Bsearchable%5D=false` +
      `&columns%5B13%5D%5Bdata%5D=id&columns%5B13%5D%5Bname%5D=actions&columns%5B13%5D%5Bsearchable%5D=false` +
      `&order%5B0%5D%5Bcolumn%5D=8&order%5B0%5D%5Bdir%5D=asc&start=0&length=50` +
      `&search=&project_id=&task_type_id=&created_by_id=` +
      `&assigned_to_group=1&pool_user_assigned=unassigned&assignee_id=&group_id=` +
      `&statuses%5B%5D=to_do&statuses%5B%5D=in_progress&_=${Date.now()}`;

    const res = await axios.get(url, { headers: getHeaders() });
    if (res.headers['set-cookie']) refreshCookies(res.headers['set-cookie']);

    let tasks = res.data?.data || [];

    // Filter theo ngày nếu có
    if (dateFilter) tasks = tasks.filter(t => (t.deadline || '').includes(dateFilter));

    // Loại trừ task type không muốn
    if (global.excludeTypes.length > 0) {
      tasks = tasks.filter(t => {
        const type = (t.task_type?.name || t.type || '').toLowerCase();
        return !global.excludeTypes.some(ex => type.includes(ex.toLowerCase()));
      });
    }

    return tasks;
  } catch (e) {
    console.error('getPoolTasks:', e.message);
    return null;
  }
}

// ===== API: MY TASKS =====
async function getMyTasks() {
  try {
    const url = `${BASE_URL}/api/v1/tasks/datatables?draw=1` +
      `&columns%5B1%5D%5Bdata%5D=id&columns%5B2%5D%5Bdata%5D=title` +
      `&columns%5B3%5D%5Bdata%5D=project&columns%5B5%5D%5Bdata%5D=task_type` +
      `&columns%5B6%5D%5Bdata%5D=status&columns%5B8%5D%5Bdata%5D=deadline` +
      `&order%5B0%5D%5Bcolumn%5D=8&order%5B0%5D%5Bdir%5D=asc&start=0&length=100` +
      `&assignee_id=${ASSIGNEE_ID}&group_id=` +
      `&statuses%5B%5D=to_do&statuses%5B%5D=in_progress&_=${Date.now()}`;
    const res = await axios.get(url, { headers: getHeaders() });
    if (res.headers['set-cookie']) refreshCookies(res.headers['set-cookie']);
    return res.data?.data || [];
  } catch (e) {
    console.error('getMyTasks:', e.message);
    return null;
  }
}

// ===== API: DONE TASKS =====
async function getDoneTasks() {
  try {
    const url = `${BASE_URL}/api/v1/tasks/datatables?draw=1` +
      `&columns%5B1%5D%5Bdata%5D=id&columns%5B2%5D%5Bdata%5D=title` +
      `&columns%5B5%5D%5Bdata%5D=task_type&columns%5B8%5D%5Bdata%5D=deadline` +
      `&order%5B0%5D%5Bcolumn%5D=8&order%5B0%5D%5Bdir%5D=desc&start=0&length=30` +
      `&assignee_id=${ASSIGNEE_ID}&statuses%5B%5D=done&_=${Date.now()}`;
    const res = await axios.get(url, { headers: getHeaders() });
    return res.data?.data || [];
  } catch (e) { return null; }
}

// ===== API: PICK TASK (assign to me) =====
async function pickTask(taskId) {
  // Dùng endpoint assignees như website thật
  const tries = [
    () => axios.post(`${BASE_URL}/api/v1/tasks/${taskId}/assignees`,
      { assignee_id: ASSIGNEE_ID },
      { headers: getHeaders() }
    ),
    () => axios.post(`${BASE_URL}/api/v1/tasks/${taskId}/assign-to-me`, {},
      { headers: getHeaders() }
    ),
  ];
  for (const fn of tries) {
    try {
      const res = await fn();
      if (res.status >= 200 && res.status < 300) {
        global.currentPickCount++;
        return res.data;
      }
    } catch (e) { continue; }
  }
  return null;
}

// ===== HELPERS =====
function deadlineTag(dl) {
  if (!dl) return '';
  const diff = Math.ceil((new Date(dl) - new Date()) / 86400000);
  if (diff < 0) return `⛔ Quá hạn`;
  if (diff === 0) return `🔴 HÔM NAY`;
  if (diff === 1) return `🟠 Ngày mai`;
  if (diff <= 3) return `🟡 Còn ${diff} ngày`;
  return `🟢 Còn ${diff} ngày`;
}

function sessionExpiredMsg(chatId) {
  bot.sendMessage(chatId,
    `❌ *Cookie hết hạn!*\n\nGõ /updatecookie để cập nhật.`,
    { parse_mode: 'Markdown' }
  );
}

// ===== COMMANDS =====

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `👋 Xin chào *${msg.from.first_name}*!\n\n🤖 *Barry Task Bot*\n\n` +
    `📋 *Lệnh:*\n` +
    `• /pool — Task chưa nhận\n` +
    `• /mytasks — Task đang làm\n` +
    `• /done — Task đã xong\n` +
    `• /stats — Thống kê cá nhân\n` +
    `• /find logo — Tìm theo từ khóa\n\n` +
    `⚡ *Auto-pick:*\n` +
    `• /autopick on 5 — Bật, tối đa 5 task\n` +
    `• /autopick off — Tắt\n` +
    `• /setmax 3 — Đổi giới hạn\n` +
    `• /status — Xem trạng thái auto-pick\n\n` +
    `🚫 *Lọc task:*\n` +
    `• /exclude Other QR — Loại trừ loại task\n` +
    `• /excludelist — Xem danh sách loại trừ\n` +
    `• /excludeclear — Xóa bộ lọc\n\n` +
    `⚙️ *Khác:*\n` +
    `• /remind — Bật nhắc deadline\n` +
    `• /updatecookie — Cập nhật cookie\n` +
    `• /myid — Xem Telegram ID`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/myid/, (msg) => {
  bot.sendMessage(msg.chat.id, `🆔 Telegram ID: \`${msg.chat.id}\``, { parse_mode: 'Markdown' });
});

// /pool
bot.onText(/\/pool(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const dateFilter = match[1]?.trim() || null;
  const lm = await bot.sendMessage(chatId, '⏳ Đang tải Pool...');
  const tasks = await getPoolTasks(dateFilter);
  await bot.deleteMessage(chatId, lm.message_id).catch(() => {});

  if (tasks === null) return sessionExpiredMsg(chatId);
  if (!tasks.length) return bot.sendMessage(chatId, '📭 Pool trống.');

  await bot.sendMessage(chatId, `📋 *Pool: ${tasks.length} task chưa nhận*${global.excludeTypes.length ? `\n🚫 Đang loại trừ: ${global.excludeTypes.join(', ')}` : ''}`, { parse_mode: 'Markdown' });

  for (const t of tasks.slice(0, 10)) {
    const dl = t.deadline || 'N/A';
    const type = t.task_type?.name || t.type || 'N/A';
    const proj = t.project?.name || t.project_info || 'N/A';
    const text = `📌 *#${t.id}* ${t.title}\n📁 ${type}\n🏢 ${proj}\n📅 ${dl} ${deadlineTag(dl)}`;
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Nhận task', callback_data: `pick_${t.id}` },
        { text: '📋 Chi tiết', callback_data: `detail_${t.id}` }
      ]]}
    });
  }
  if (tasks.length > 10) await bot.sendMessage(chatId, `_Hiển thị 10/${tasks.length}. Dùng /find để lọc._`, { parse_mode: 'Markdown' });
});

// /mytasks
bot.onText(/\/mytasks/, async (msg) => {
  const chatId = msg.chat.id;
  const lm = await bot.sendMessage(chatId, '⏳ Đang tải...');
  const tasks = await getMyTasks();
  await bot.deleteMessage(chatId, lm.message_id).catch(() => {});
  if (tasks === null) return sessionExpiredMsg(chatId);
  if (!tasks.length) return bot.sendMessage(chatId, '📭 Bạn chưa có task đang làm.');

  let text = `📋 *Task đang làm: ${tasks.length} task*\n\n`;
  tasks.forEach((t, i) => {
    const dl = t.deadline || 'N/A';
    const type = t.task_type?.name || '';
    text += `${i + 1}. *#${t.id}* ${t.title?.substring(0, 35)}\n   ${type} | 📅 ${dl} ${deadlineTag(dl)}\n\n`;
  });
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

// /done
bot.onText(/\/done(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const lm = await bot.sendMessage(chatId, '⏳ Đang tải...');
  const tasks = await getDoneTasks();
  await bot.deleteMessage(chatId, lm.message_id).catch(() => {});
  if (tasks === null) return sessionExpiredMsg(chatId);
  if (!tasks.length) return bot.sendMessage(chatId, '📭 Chưa có task hoàn thành.');
  let text = `✅ *Task đã xong: ${tasks.length} task*\n\n`;
  tasks.slice(0, 15).forEach((t, i) => {
    text += `${i + 1}. #${t.id} ${t.title?.substring(0, 35)} | ${t.deadline || 'N/A'}\n`;
  });
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

// /stats
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const lm = await bot.sendMessage(chatId, '⏳ Đang tính...');
  const [doing, done] = await Promise.all([getMyTasks(), getDoneTasks()]);
  await bot.deleteMessage(chatId, lm.message_id).catch(() => {});
  if (doing === null) return sessionExpiredMsg(chatId);

  const byType = {};
  [...(doing||[]), ...(done||[])].forEach(t => {
    const type = t.task_type?.name || 'Other';
    byType[type] = (byType[type] || 0) + 1;
  });

  const urgent = (doing||[]).filter(t => {
    const diff = Math.ceil((new Date(t.deadline) - new Date()) / 86400000);
    return diff >= 0 && diff <= 2;
  });

  let text = `📊 *Thống kê — Barry Trinh*\n\n`;
  text += `🔄 Đang làm: *${(doing||[]).length} task*\n`;
  text += `✅ Đã xong: *${(done||[]).length} task*\n\n`;
  text += `*Theo loại:*\n`;
  Object.entries(byType).sort((a,b)=>b[1]-a[1]).forEach(([type, count]) => {
    text += `• ${type}: ${'█'.repeat(Math.min(count,8))} ${count}\n`;
  });
  if (urgent.length > 0) {
    text += `\n⚠️ *Sắp hết hạn (≤2 ngày):*\n`;
    urgent.forEach(t => { text += `• #${t.id} ${t.title?.substring(0,30)} | ${t.deadline}\n`; });
  }
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

// /find
bot.onText(/\/find (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const kw = match[1].toLowerCase().trim();
  const lm = await bot.sendMessage(chatId, `🔍 Tìm "${kw}"...`);
  const tasks = await getPoolTasks();
  await bot.deleteMessage(chatId, lm.message_id).catch(() => {});
  if (tasks === null) return sessionExpiredMsg(chatId);
  const found = tasks.filter(t =>
    t.title?.toLowerCase().includes(kw) ||
    t.task_type?.name?.toLowerCase().includes(kw) ||
    (t.project?.name||'').toLowerCase().includes(kw)
  );
  if (!found.length) return bot.sendMessage(chatId, `📭 Không tìm thấy "${kw}".`);
  await bot.sendMessage(chatId, `🔍 *${found.length} kết quả*`, { parse_mode: 'Markdown' });
  for (const t of found.slice(0,8)) {
    const dl = t.deadline || 'N/A';
    await bot.sendMessage(chatId, `📌 *#${t.id}* ${t.title}\n📅 ${dl} ${deadlineTag(dl)}`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Nhận task', callback_data: `pick_${t.id}` },
        { text: '📋 Chi tiết', callback_data: `detail_${t.id}` }
      ]]}
    });
  }
});

// ===== AUTO-PICK =====
bot.onText(/\/autopick on ?(\d*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const max = parseInt(match[1]) || 5;
  global.autoPick = true;
  global.maxAutoPick = max;
  global.currentPickCount = 0;
  global.reminderChatId = chatId;

  // Reset danh sách task đã biết
  const tasks = await getPoolTasks();
  if (tasks) tasks.forEach(t => global.knownTaskIds.add(t.id));

  bot.sendMessage(chatId,
    `⚡ *Auto-pick đã BẬT!*\n\n` +
    `• Check task mới mỗi *30 giây*\n` +
    `• Tối đa: *${max} task*\n` +
    `• Đã pick hôm nay: *${global.currentPickCount}*\n\n` +
    `Gõ /autopick off để tắt.\nGõ /setmax [số] để đổi giới hạn.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/autopick off/, (msg) => {
  global.autoPick = false;
  bot.sendMessage(msg.chat.id, `⏹ *Auto-pick đã TẮT.*\nĐã pick: ${global.currentPickCount} task.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/setmax (\d+)/, (msg, match) => {
  global.maxAutoPick = parseInt(match[1]);
  bot.sendMessage(msg.chat.id, `✅ Giới hạn auto-pick: *${global.maxAutoPick} task*`, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, (msg) => {
  const status = global.autoPick ? '🟢 BẬT' : '🔴 TẮT';
  bot.sendMessage(msg.chat.id,
    `📊 *Trạng thái Auto-pick*\n\n` +
    `• Trạng thái: ${status}\n` +
    `• Giới hạn tối đa: *${global.maxAutoPick} task*\n` +
    `• Đã pick: *${global.currentPickCount} task*\n` +
    `• Loại trừ: ${global.excludeTypes.length ? global.excludeTypes.join(', ') : 'Không có'}`,
    { parse_mode: 'Markdown' }
  );
});

// ===== FILTER / LOẠI TRỪ =====
bot.onText(/\/exclude (.+)/, (msg, match) => {
  const types = match[1].split(' ').filter(Boolean);
  global.excludeTypes = [...new Set([...global.excludeTypes, ...types])];
  bot.sendMessage(msg.chat.id,
    `🚫 *Đang loại trừ:*\n${global.excludeTypes.map(t => `• ${t}`).join('\n')}\n\nDùng /excludeclear để xóa.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/excludelist/, (msg) => {
  if (!global.excludeTypes.length) return bot.sendMessage(msg.chat.id, '✅ Chưa có loại trừ nào.');
  bot.sendMessage(msg.chat.id, `🚫 *Loại đang bị loại trừ:*\n${global.excludeTypes.map(t=>`• ${t}`).join('\n')}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/excludeclear/, (msg) => {
  global.excludeTypes = [];
  bot.sendMessage(msg.chat.id, '✅ Đã xóa tất cả bộ lọc loại trừ.');
});

// ===== REMIND =====
bot.onText(/\/remind$/, (msg) => {
  global.reminderChatId = msg.chat.id;
  bot.sendMessage(msg.chat.id, `⏰ *Nhắc deadline BẬT!*\n• 8:00 sáng — hôm nay\n• 21:00 tối — ngày mai`, { parse_mode: 'Markdown' });
});

bot.onText(/\/remindoff/, (msg) => {
  global.reminderChatId = null;
  bot.sendMessage(msg.chat.id, '🔕 Đã tắt nhắc deadline.');
});

// ===== UPDATE COOKIE =====
bot.onText(/\/updatecookie/, (msg) => {
  waitingForCookie[msg.chat.id] = 'session';
  bot.sendMessage(msg.chat.id,
    `🔄 *Cập nhật Cookie*\n\n1. Chrome → mpm.macusaone.com/tasks\n2. F12 → Application → Cookies\n3. Copy *mpm-mac-usa-one-session* → paste đây:`,
    { parse_mode: 'Markdown' }
  );
});

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  if (!waitingForCookie[chatId] || msg.text?.startsWith('/')) return;
  if (waitingForCookie[chatId] === 'session') {
    SESSION_COOKIE = msg.text.trim();
    waitingForCookie[chatId] = 'xsrf';
    bot.sendMessage(chatId, `✅ Session lưu rồi!\n\nPaste *XSRF-TOKEN*:`, { parse_mode: 'Markdown' });
  } else if (waitingForCookie[chatId] === 'xsrf') {
    XSRF_TOKEN = msg.text.trim();
    delete waitingForCookie[chatId];
    bot.sendMessage(chatId, `✅ *Cookie cập nhật xong!*\nThử /pool để kiểm tra.`, { parse_mode: 'Markdown' });
  }
});

// ===== CALLBACK BUTTONS =====
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith('pick_')) {
    const taskId = data.replace('pick_', '');
    await bot.answerCallbackQuery(query.id, { text: '⏳ Đang nhận...' });

    if (global.currentPickCount >= global.maxAutoPick && global.autoPick) {
      return bot.sendMessage(chatId, `⚠️ Đã đạt giới hạn *${global.maxAutoPick} task*!\nGõ /setmax để tăng giới hạn.`, { parse_mode: 'Markdown' });
    }

    const result = await pickTask(taskId);
    if (result) {
      const now = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      await bot.sendMessage(chatId,
        `✅ *Task #${taskId} nhận thành công!*\n🕐 Lúc: ${now}\nDùng /mytasks để xem.`,
        { parse_mode: 'Markdown' }
      );
      await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ Đã nhận', callback_data: 'done' }]] }, {
        chat_id: chatId, message_id: query.message.message_id
      }).catch(() => {});
    } else {
      await bot.sendMessage(chatId, `❌ Không nhận được #${taskId}.\nTask đã bị pick hoặc cookie hết hạn.\nThử /updatecookie.`);
    }
  }

  if (data.startsWith('detail_')) {
    const taskId = data.replace('detail_', '');
    await bot.answerCallbackQuery(query.id, { text: '⏳ Đang tải...' });
    try {
      const res = await axios.get(`${BASE_URL}/api/v1/tasks/${taskId}`, { headers: getHeaders() });
      const task = res.data?.data || res.data;
      const dl = task.deadline || 'N/A';
      const proj = task.project?.name || 'N/A';
      const type = task.task_type?.name || 'N/A';
      let text = `📌 *Task #${task.id}*\n*Tiêu đề:* ${task.title}\n*Dự án:* ${proj}\n*Loại:* ${type}\n*Deadline:* ${dl} ${deadlineTag(dl)}`;
      if (task.description) {
        const desc = task.description.replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').trim().substring(0,300);
        if (desc) text += `\n\n📝 *Mô tả:*\n${desc}`;
      }
      await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '✅ Nhận task này', callback_data: `pick_${taskId}` }]] }
      });
    } catch(e) {
      await bot.sendMessage(chatId, `❌ Không lấy được chi tiết #${taskId}.`);
    }
  }
});

// ===== AUTO-PICK POLLING (mỗi 30 giây) =====
setInterval(async () => {
  if (!global.autoPick || !global.reminderChatId) return;
  if (global.currentPickCount >= global.maxAutoPick) return;

  const tasks = await getPoolTasks();
  if (!tasks?.length) return;

  // Tìm task MỚI (chưa thấy trước đó)
  const newTasks = tasks.filter(t => !global.knownTaskIds.has(t.id));

  for (const t of newTasks) {
    global.knownTaskIds.add(t.id);
    if (global.currentPickCount >= global.maxAutoPick) break;

    const now = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const dl = t.deadline || 'N/A';
    const type = t.task_type?.name || 'N/A';

    // Thông báo task mới
    await bot.sendMessage(global.reminderChatId,
      `🔔 *Task mới xuất hiện!*\n\n📌 *#${t.id}* ${t.title}\n📁 ${type}\n📅 ${dl} ${deadlineTag(dl)}\n🕐 ${now}`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: '⚡ Nhận ngay', callback_data: `pick_${t.id}` },
          { text: '📋 Chi tiết', callback_data: `detail_${t.id}` }
        ]]}
      }
    );
  }
}, 30000);

// ===== CRON: NHẮC DEADLINE =====
cron.schedule('0 8 * * *', async () => {
  if (!global.reminderChatId) return;
  const tasks = await getMyTasks();
  if (!tasks?.length) return;
  const today = new Date().toISOString().split('T')[0];
  const todayTasks = tasks.filter(t => (t.deadline||'').startsWith(today));
  if (todayTasks.length > 0) {
    let text = `🔴 *Task hết hạn HÔM NAY!*\n\n`;
    todayTasks.forEach(t => { text += `• #${t.id} ${t.title}\n`; });
    bot.sendMessage(global.reminderChatId, text, { parse_mode: 'Markdown' });
  }
}, { timezone: 'Asia/Ho_Chi_Minh' });

cron.schedule('0 21 * * *', async () => {
  if (!global.reminderChatId) return;
  const tasks = await getMyTasks();
  if (!tasks?.length) return;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tmStr = tomorrow.toISOString().split('T')[0];
  const tmTasks = tasks.filter(t => (t.deadline||'').startsWith(tmStr));
  if (tmTasks.length > 0) {
    let text = `🟠 *Task hết hạn NGÀY MAI!*\n\n`;
    tmTasks.forEach(t => { text += `• #${t.id} ${t.title}\n`; });
    bot.sendMessage(global.reminderChatId, text, { parse_mode: 'Markdown' });
  }
}, { timezone: 'Asia/Ho_Chi_Minh' });

console.log('🤖 Barry Task Bot v2 đang chạy...');
console.log(`👤 Assignee ID: ${ASSIGNEE_ID}`);
console.log('✅ Sẵn sàng!');
