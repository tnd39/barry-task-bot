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

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const waitingForCookie = {};

function getHeaders() {
  return {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Content-Type': 'application/json',
    'X-XSRF-TOKEN': decodeURIComponent(XSRF_TOKEN),
    'X-Requested-With': 'XMLHttpRequest',
    'Cookie': `mpm-mac-usa-one-session=${SESSION_COOKIE}; XSRF-TOKEN=${XSRF_TOKEN}`,
    'Referer': `${BASE_URL}/tasks`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0'
  };
}

function refreshCookies(setCookieArr) {
  setCookieArr.forEach(c => {
    if (c.includes('mpm-mac-usa-one-session')) {
      SESSION_COOKIE = c.split(';')[0].split('=').slice(1).join('=');
    }
    if (c.includes('XSRF-TOKEN')) {
      XSRF_TOKEN = c.split(';')[0].split('=').slice(1).join('=');
    }
  });
}

async function getPoolTasks(dateFilter = null) {
  try {
    const url = `${BASE_URL}/api/v1/tasks/datatables?draw=1` +
      `&columns[0][data]=id&columns[0][name]=id&columns[0][searchable]=false&columns[0][orderable]=false` +
      `&columns[1][data]=title&columns[1][name]=title&columns[1][searchable]=true&columns[1][orderable]=false` +
      `&columns[2][data]=project&columns[2][name]=project&columns[2][searchable]=true&columns[2][orderable]=false` +
      `&columns[3][data]=account_manager&columns[3][name]=account_manager&columns[3][searchable]=false` +
      `&columns[4][data]=task_type&columns[4][name]=task_type&columns[4][searchable]=true&columns[4][orderable]=false` +
      `&columns[5][data]=status&columns[5][name]=status&columns[5][searchable]=false` +
      `&columns[6][data]=deadline&columns[6][name]=deadline&columns[6][searchable]=false` +
      `&columns[7][data]=assignees&columns[7][name]=assignees&columns[7][searchable]=false` +
      `&columns[8][data]=actions&columns[8][name]=actions&columns[8][searchable]=false&columns[8][orderable]=false` +
      `&order[0][column]=7&order[0][dir]=asc&start=0&length=50` +
      `&search=&pool_user_assigned=all&assignee_id=151&group_id=` +
      `&statuses[]=to_do&statuses[]=in_progress&_=${Date.now()}`;
    const res = await axios.get(url, { headers: getHeaders() });
    if (res.headers['set-cookie']) refreshCookies(res.headers['set-cookie']);
    let tasks = res.data?.data || [];
    if (dateFilter) tasks = tasks.filter(t => (t.deadline || t.due_date || '').includes(dateFilter));
    return tasks;
  } catch (e) {
    console.error('getPoolTasks:', e.message);
    return null;
  }
}

async function getMyTasks() {
  try {
    const url = `${BASE_URL}/api/v1/tasks/datatables?draw=1` +
      `&columns[0][data]=id&columns[1][data]=title&columns[2][data]=project` +
      `&columns[3][data]=task_type&columns[4][data]=status&columns[5][data]=deadline` +
      `&order[0][column]=5&order[0][dir]=asc&start=0&length=100` +
      `&assignee_id=${ASSIGNEE_ID}&statuses[]=to_do&statuses[]=in_progress&_=${Date.now()}`;
    const res = await axios.get(url, { headers: getHeaders() });
    if (res.headers['set-cookie']) refreshCookies(res.headers['set-cookie']);
    return res.data?.data || [];
  } catch (e) {
    console.error('getMyTasks:', e.message);
    return null;
  }
}

async function getDoneTasks() {
  try {
    const url = `${BASE_URL}/api/v1/tasks/datatables?draw=1` +
      `&columns[0][data]=id&columns[1][data]=title&columns[2][data]=project` +
      `&columns[3][data]=task_type&columns[4][data]=status&columns[5][data]=deadline` +
      `&order[0][column]=5&order[0][dir]=desc&start=0&length=30` +
      `&assignee_id=${ASSIGNEE_ID}&statuses[]=done&_=${Date.now()}`;
    const res = await axios.get(url, { headers: getHeaders() });
    return res.data?.data || [];
  } catch (e) {
    console.error('getDoneTasks:', e.message);
    return null;
  }
}

async function getTaskDetail(taskId) {
  try {
    const res = await axios.get(`${BASE_URL}/api/v1/tasks/${taskId}`, { headers: getHeaders() });
    return res.data?.data || res.data;
  } catch (e) {
    return null;
  }
}

async function pickTask(taskId) {
  const tries = [
    () => axios.post(`${BASE_URL}/api/v1/tasks/${taskId}/assign-to-me`, {}, { headers: getHeaders() }),
    () => axios.post(`${BASE_URL}/api/v1/tasks/${taskId}/assignees`, { assignee_id: ASSIGNEE_ID }, { headers: getHeaders() }),
    () => axios.patch(`${BASE_URL}/api/v1/tasks/${taskId}`, { assignee_id: ASSIGNEE_ID }, { headers: getHeaders() }),
  ];
  for (const fn of tries) {
    try {
      const res = await fn();
      if (res.status >= 200 && res.status < 300) return res.data;
    } catch (e) { continue; }
  }
  return null;
}

function deadlineTag(deadline) {
  if (!deadline) return '';
  const diff = Math.ceil((new Date(deadline) - new Date()) / 86400000);
  if (diff < 0) return `⛔ Quá hạn ${Math.abs(diff)} ngày`;
  if (diff === 0) return `🔴 HÔM NAY`;
  if (diff === 1) return `🟠 Ngày mai`;
  if (diff <= 3) return `🟡 Còn ${diff} ngày`;
  return `🟢 Còn ${diff} ngày`;
}

function taskCard(task) {
  const dl = task.deadline || task.due_date || 'N/A';
  const proj = task.project?.name || task.project_info || 'N/A';
  const type = task.task_type?.name || task.type || 'N/A';
  let text = `📌 *Task #${task.id}*\n*Tiêu đề:* ${task.title}\n*Dự án:* ${proj}\n*Loại:* ${type}\n*Deadline:* ${dl} ${deadlineTag(dl)}`;
  if (task.description) {
    const desc = task.description.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().substring(0, 300);
    if (desc) text += `\n\n📝 *Mô tả:*\n${desc}`;
  }
  return text;
}

function sessionExpiredMsg(chatId) {
  bot.sendMessage(chatId,
    `❌ *Cookie hết hạn!*\n\nGõ /updatecookie để cập nhật cookie mới.\n\n` +
    `Hoặc vào Chrome → F12 → Application → Cookies → copy *mpm-mac-usa-one-session* và *XSRF-TOKEN*.`,
    { parse_mode: 'Markdown' }
  );
}

// ===== COMMANDS =====

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `👋 Xin chào *${msg.from.first_name}*!\n\n🤖 *Barry Task Bot* — pick task nhanh từ điện thoại.\n\n` +
    `📋 *Lệnh:*\n• /pool — Task chưa nhận\n• /mytasks — Task đang làm\n• /done — Task đã xong\n` +
    `• /stats — Thống kê cá nhân\n• /find logo — Tìm theo từ khóa\n• /remind — Bật nhắc deadline\n` +
    `• /remindoff — Tắt nhắc\n• /updatecookie — Cập nhật cookie\n• /myid — Xem Telegram ID`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/myid/, (msg) => {
  bot.sendMessage(msg.chat.id, `🆔 Telegram ID: \`${msg.chat.id}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/pool(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const dateFilter = match[1]?.trim() || null;
  const lm = await bot.sendMessage(chatId, '⏳ Đang tải Pool...');
  const tasks = await getPoolTasks(dateFilter);
  await bot.deleteMessage(chatId, lm.message_id).catch(() => {});
  if (tasks === null) return sessionExpiredMsg(chatId);
  if (!tasks.length) return bot.sendMessage(chatId, '📭 Pool trống.');

  await bot.sendMessage(chatId, `📋 *Pool: ${tasks.length} task chưa nhận*`, { parse_mode: 'Markdown' });
  for (const t of tasks.slice(0, 10)) {
    const dl = t.deadline || t.due_date || 'N/A';
    const type = t.task_type?.name || '';
    const proj = t.project?.name || t.project_info || '';
    const text = `📌 *#${t.id}* ${t.title}\n📁 ${type} | 🏢 ${proj}\n📅 ${dl} ${deadlineTag(dl)}`;
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

bot.onText(/\/mytasks/, async (msg) => {
  const chatId = msg.chat.id;
  const lm = await bot.sendMessage(chatId, '⏳ Đang tải...');
  const tasks = await getMyTasks();
  await bot.deleteMessage(chatId, lm.message_id).catch(() => {});
  if (tasks === null) return sessionExpiredMsg(chatId);
  if (!tasks.length) return bot.sendMessage(chatId, '📭 Bạn chưa có task đang làm.');

  let text = `📋 *Task đang làm: ${tasks.length} task*\n\n`;
  tasks.forEach((t, i) => {
    const dl = t.deadline || t.due_date || 'N/A';
    const type = t.task_type?.name || '';
    text += `${i + 1}. *#${t.id}* ${t.title?.substring(0, 35)}\n   ${type} | 📅 ${dl} ${deadlineTag(dl)}\n\n`;
  });
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/done(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const dateFilter = match[1]?.trim() || null;
  const lm = await bot.sendMessage(chatId, '⏳ Đang tải...');
  const tasks = await getDoneTasks();
  await bot.deleteMessage(chatId, lm.message_id).catch(() => {});
  if (tasks === null) return sessionExpiredMsg(chatId);
  let filtered = tasks;
  if (dateFilter) filtered = tasks.filter(t => (t.deadline || t.due_date || '').includes(dateFilter));
  if (!filtered.length) return bot.sendMessage(chatId, '📭 Chưa có task hoàn thành.');

  let text = `✅ *Task đã xong: ${filtered.length} task*\n\n`;
  filtered.slice(0, 15).forEach((t, i) => {
    const dl = t.deadline || t.due_date || 'N/A';
    const type = t.task_type?.name || '';
    text += `${i + 1}. #${t.id} ${t.title?.substring(0, 35)} — ${type} | ${dl}\n`;
  });
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const lm = await bot.sendMessage(chatId, '⏳ Đang tính thống kê...');
  const [doing, done] = await Promise.all([getMyTasks(), getDoneTasks()]);
  await bot.deleteMessage(chatId, lm.message_id).catch(() => {});
  if (doing === null) return sessionExpiredMsg(chatId);

  const byType = {};
  [...(doing || []), ...(done || [])].forEach(t => {
    const type = t.task_type?.name || 'Other';
    byType[type] = (byType[type] || 0) + 1;
  });

  const urgent = (doing || []).filter(t => {
    const diff = Math.ceil((new Date(t.deadline || t.due_date) - new Date()) / 86400000);
    return diff >= 0 && diff <= 2;
  });

  let text = `📊 *Thống kê — Barry Trinh*\n\n`;
  text += `🔄 Đang làm: *${(doing || []).length} task*\n`;
  text += `✅ Đã xong: *${(done || []).length} task*\n\n`;
  text += `*Theo loại:*\n`;
  Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
    text += `• ${type}: ${'█'.repeat(Math.min(count, 8))} ${count}\n`;
  });
  if (urgent.length > 0) {
    text += `\n⚠️ *Sắp hết hạn (≤ 2 ngày):*\n`;
    urgent.forEach(t => { text += `• #${t.id} ${t.title?.substring(0, 30)} | ${t.deadline || t.due_date}\n`; });
  }
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/find (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const kw = match[1].toLowerCase().trim();
  const lm = await bot.sendMessage(chatId, `🔍 Đang tìm "${kw}"...`);
  const tasks = await getPoolTasks();
  await bot.deleteMessage(chatId, lm.message_id).catch(() => {});
  if (tasks === null) return sessionExpiredMsg(chatId);

  const found = tasks.filter(t =>
    t.title?.toLowerCase().includes(kw) ||
    t.task_type?.name?.toLowerCase().includes(kw) ||
    (t.project?.name || '').toLowerCase().includes(kw)
  );
  if (!found.length) return bot.sendMessage(chatId, `📭 Không tìm thấy task với "${kw}".`);

  await bot.sendMessage(chatId, `🔍 *${found.length} kết quả cho "${kw}"*`, { parse_mode: 'Markdown' });
  for (const t of found.slice(0, 8)) {
    const dl = t.deadline || t.due_date || 'N/A';
    await bot.sendMessage(chatId, `📌 *#${t.id}* ${t.title}\n📅 ${dl} ${deadlineTag(dl)}`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Nhận task', callback_data: `pick_${t.id}` },
        { text: '📋 Chi tiết', callback_data: `detail_${t.id}` }
      ]]}
    });
  }
});

bot.onText(/\/remind$/, (msg) => {
  global.reminderChatId = msg.chat.id;
  bot.sendMessage(msg.chat.id,
    `⏰ *Nhắc deadline đã BẬT!*\n\n• 🌅 8:00 sáng — hết hạn hôm nay\n• 🌙 21:00 tối — hết hạn ngày mai\n\nGõ /remindoff để tắt.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/remindoff/, (msg) => {
  global.reminderChatId = null;
  bot.sendMessage(msg.chat.id, '🔕 Đã tắt nhắc deadline.');
});

bot.onText(/\/updatecookie/, (msg) => {
  waitingForCookie[msg.chat.id] = 'session';
  bot.sendMessage(msg.chat.id,
    `🔄 *Cập nhật Cookie*\n\n1. Chrome → mpm.macusaone.com/tasks\n2. F12 → Application → Cookies\n3. Click *mpm-mac-usa-one-session* → copy full value\n\n_Paste vào đây:_`,
    { parse_mode: 'Markdown' }
  );
});

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  if (!waitingForCookie[chatId] || msg.text?.startsWith('/')) return;
  if (waitingForCookie[chatId] === 'session') {
    SESSION_COOKIE = msg.text.trim();
    waitingForCookie[chatId] = 'xsrf';
    bot.sendMessage(chatId, `✅ Session lưu rồi!\n\nBây giờ paste *XSRF-TOKEN*:`, { parse_mode: 'Markdown' });
  } else if (waitingForCookie[chatId] === 'xsrf') {
    XSRF_TOKEN = msg.text.trim();
    delete waitingForCookie[chatId];
    bot.sendMessage(chatId, `✅ *Cookie cập nhật xong!*\nThử /pool để kiểm tra.`, { parse_mode: 'Markdown' });
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith('pick_')) {
    const taskId = data.replace('pick_', '');
    await bot.answerCallbackQuery(query.id, { text: '⏳ Đang nhận...' });
    const result = await pickTask(taskId);
    if (result) {
      await bot.sendMessage(chatId, `✅ *Task #${taskId} nhận thành công!*\nDùng /mytasks để xem.`, { parse_mode: 'Markdown' });
      await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ Đã nhận', callback_data: 'done' }]] }, {
        chat_id: chatId, message_id: query.message.message_id
      }).catch(() => {});
    } else {
      await bot.sendMessage(chatId, `❌ Không nhận được #${taskId}. Task đã bị pick hoặc cookie hết hạn.\nThử /updatecookie.`);
    }
  }

  if (data.startsWith('detail_')) {
    const taskId = data.replace('detail_', '');
    await bot.answerCallbackQuery(query.id, { text: '⏳ Đang tải...' });
    const task = await getTaskDetail(taskId);
    if (task) {
      await bot.sendMessage(chatId, taskCard(task), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '✅ Nhận task này', callback_data: `pick_${taskId}` }]] }
      });
    } else {
      await bot.sendMessage(chatId, `❌ Không lấy được chi tiết #${taskId}.`);
    }
  }
});

// ===== CRON =====
cron.schedule('0 8 * * *', async () => {
  if (!global.reminderChatId) return;
  const tasks = await getMyTasks();
  if (!tasks?.length) return;
  const today = new Date().toISOString().split('T')[0];
  const todayTasks = tasks.filter(t => (t.deadline || t.due_date || '').startsWith(today));
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
  const tmTasks = tasks.filter(t => (t.deadline || t.due_date || '').startsWith(tmStr));
  if (tmTasks.length > 0) {
    let text = `🟠 *Task hết hạn NGÀY MAI!*\n\n`;
    tmTasks.forEach(t => { text += `• #${t.id} ${t.title}\n`; });
    bot.sendMessage(global.reminderChatId, text, { parse_mode: 'Markdown' });
  }
}, { timezone: 'Asia/Ho_Chi_Minh' });

console.log('🤖 Barry Task Bot đang chạy...');
console.log(`👤 Assignee ID: ${ASSIGNEE_ID}`);
console.log('✅ Sẵn sàng!');
