import type { ChatMessage } from '../types';

/**
 * Fallback file templates used when the model repeatedly fails to emit a
 * real tool call after enforcement retries (extracted from agentLoop.ts so
 * loop logic stays separate from static content).
 *
 * The filename and content are inferred from the user's last message:
 *   - login/register html → themed demo page
 *   - any other .html     → generic landing card
 *   - html/page/site keywords (without .html) → calculator script.js
 *   - default             → python task manager main.py
 */
export function buildFallbackFile(
  history: ChatMessage[],
  language: 'fa' | 'en'
): { filename: string; content: string } {
const lastUser = [...history].reverse().find((m) => m.role === 'user');
const userText = (lastUser?.content ?? '').toLowerCase();
const isFa = language === 'fa';

// Try to extract a specific filename from user's request
const fileNameMatch = userText.match(/(?:ساز|ایجاد|نویس|create|make|build|write)\s+([\w-]+\.(?:html|js|ts|py|json|css|md|txt|jsx|tsx|vue|svelte))/i) ||
                      userText.match(/([\w-]+\.(?:html|js|ts|py|json|css|md|txt|jsx|tsx|vue|svelte))/i);
const suggestedFilename = fileNameMatch ? fileNameMatch[1] : null;

let filename: string;
let content: string;

// If user specified a filename like login.html, use it
if (suggestedFilename && suggestedFilename.endsWith('.html')) {
  filename = suggestedFilename;
  const isLogin = suggestedFilename.includes('login') || userText.includes('login') || userText.includes('ورود') || userText.includes('signin') || userText.includes('sign in');
  const isRegister = suggestedFilename.includes('register') || userText.includes('register') || userText.includes('ثبت نام') || userText.includes('signup');
  
  if (isLogin) {
    content = isFa
      ? `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ورود</title>
  <style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Vazirmatn', sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
.login-card { background: rgba(255,255,255,0.05); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 3rem; width: 100%; max-width: 400px; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
.login-card h1 { text-align: center; margin-bottom: 0.5rem; background: linear-gradient(135deg, #FE03C3, #3794ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-size: 2rem; }
.login-card .subtitle { text-align: center; color: #aaa; margin-bottom: 2rem; }
.form-group { margin-bottom: 1.5rem; }
.form-group label { display: block; margin-bottom: 0.5rem; color: #ddd; font-size: 0.9rem; }
.form-group input { width: 100%; padding: 1rem; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #fff; font-family: inherit; font-size: 1rem; outline: none; transition: border-color 0.2s; }
.form-group input:focus { border-color: #FE03C3; }
.btn { width: 100%; padding: 1rem; background: linear-gradient(135deg, #FE03C3, #3794ff); border: none; border-radius: 8px; color: #fff; font-size: 1rem; font-family: inherit; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; }
.btn:hover { transform: translateY(-2px); box-shadow: 0 10px 20px rgba(254,3,195,0.3); }
.links { text-align: center; margin-top: 1.5rem; color: #888; }
.links a { color: #FE03C3; text-decoration: none; }
.links a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="login-card">
<h1>ورود به حساب کاربری</h1>
<p class="subtitle">برای ادامه، لطفاً وارد شوید</p>
<form id="loginForm">
  <div class="form-group">
    <label for="email">ایمیل یا نام کاربری</label>
    <input type="email" id="email" name="email" required autocomplete="email" placeholder="example@domain.com">
  </div>
  <div class="form-group">
    <label for="password">رمز عبور</label>
    <input type="password" id="password" name="password" required autocomplete="current-password" placeholder="••••••••">
  </div>
  <button type="submit" class="btn">ورود</button>
</form>
<div class="links">
  <a href="#">رمز عبور را فراموش کرده‌ام</a> | <a href="#">ثبت نام</a>
</div>
  </div>
  <script>
document.getElementById('loginForm').addEventListener('submit', function(e) {
  e.preventDefault();
  alert('فرم ورود ارسال شد! (این یک دمو است)');
});
  </script>
</body>
</html>`
      : `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login</title>
  <style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: system-ui, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
.login-card { background: rgba(255,255,255,0.05); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 3rem; width: 100%; max-width: 400px; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
.login-card h1 { text-align: center; margin-bottom: 0.5rem; background: linear-gradient(135deg, #FE03C3, #3794ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-size: 2rem; }
.login-card .subtitle { text-align: center; color: #aaa; margin-bottom: 2rem; }
.form-group { margin-bottom: 1.5rem; }
.form-group label { display: block; margin-bottom: 0.5rem; color: #ddd; font-size: 0.9rem; }
.form-group input { width: 100%; padding: 1rem; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #fff; font-family: inherit; font-size: 1rem; outline: none; transition: border-color 0.2s; }
.form-group input:focus { border-color: #FE03C3; }
.btn { width: 100%; padding: 1rem; background: linear-gradient(135deg, #FE03C3, #3794ff); border: none; border-radius: 8px; color: #fff; font-size: 1rem; font-family: inherit; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; }
.btn:hover { transform: translateY(-2px); box-shadow: 0 10px 20px rgba(254,3,195,0.3); }
.links { text-align: center; margin-top: 1.5rem; color: #888; }
.links a { color: #FE03C3; text-decoration: none; }
.links a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="login-card">
<h1>Login to Your Account</h1>
<p class="subtitle">Please sign in to continue</p>
<form id="loginForm">
  <div class="form-group">
    <label for="email">Email or Username</label>
    <input type="email" id="email" name="email" required autocomplete="email" placeholder="example@domain.com">
  </div>
  <div class="form-group">
    <label for="password">Password</label>
    <input type="password" id="password" name="password" required autocomplete="current-password" placeholder="••••••••">
  </div>
  <button type="submit" class="btn">Sign In</button>
</form>
<div class="links">
  <a href="#">Forgot Password?</a> | <a href="#">Sign Up</a>
</div>
  </div>
  <script>
document.getElementById('loginForm').addEventListener('submit', function(e) {
  e.preventDefault();
  alert('Login form submitted! (This is a demo)');
});
  </script>
</body>
</html>`;
  } else if (isRegister) {
    content = isFa
      ? `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ثبت نام</title>
  <style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Vazirmatn', sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
.register-card { background: rgba(255,255,255,0.05); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 3rem; width: 100%; max-width: 400px; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
.register-card h1 { text-align: center; margin-bottom: 0.5rem; background: linear-gradient(135deg, #FE03C3, #3794ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-size: 2rem; }
.register-card .subtitle { text-align: center; color: #aaa; margin-bottom: 2rem; }
.form-group { margin-bottom: 1.5rem; }
.form-group label { display: block; margin-bottom: 0.5rem; color: #ddd; font-size: 0.9rem; }
.form-group input { width: 100%; padding: 1rem; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #fff; font-family: inherit; font-size: 1rem; outline: none; transition: border-color 0.2s; }
.form-group input:focus { border-color: #FE03C3; }
.btn { width: 100%; padding: 1rem; background: linear-gradient(135deg, #FE03C3, #3794ff); border: none; border-radius: 8px; color: #fff; font-size: 1rem; font-family: inherit; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; }
.btn:hover { transform: translateY(-2px); box-shadow: 0 10px 20px rgba(254,3,195,0.3); }
.links { text-align: center; margin-top: 1.5rem; color: #888; }
.links a { color: #FE03C3; text-decoration: none; }
.links a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="register-card">
<h1>ایجاد حساب کاربری</h1>
<p class="subtitle">برای شروع، لطفاً ثبت نام کنید</p>
<form id="registerForm">
  <div class="form-group">
    <label for="name">نام کامل</label>
    <input type="text" id="name" name="name" required autocomplete="name" placeholder="نام و نام خانوادگی">
  </div>
  <div class="form-group">
    <label for="email">ایمیل</label>
    <input type="email" id="email" name="email" required autocomplete="email" placeholder="example@domain.com">
  </div>
  <div class="form-group">
    <label for="password">رمز عبور</label>
    <input type="password" id="password" name="password" required autocomplete="new-password" minlength="8" placeholder="حداقل ۸ کاراکتر">
  </div>
  <div class="form-group">
    <label for="confirmPassword">تکرار رمز عبور</label>
    <input type="password" id="confirmPassword" name="confirmPassword" required autocomplete="new-password" placeholder="تکرار رمز عبور">
  </div>
  <button type="submit" class="btn">ثبت نام</button>
</form>
<div class="links">
  <a href="#">حساب کاربری دارید؟ وارد شوید</a>
</div>
  </div>
  <script>
document.getElementById('registerForm').addEventListener('submit', function(e) {
  e.preventDefault();
  const pass = document.getElementById('password').value;
  const confirm = document.getElementById('confirmPassword').value;
  if (pass !== confirm) { alert('رمزهای عبور مطابقت ندارند'); return; }
  alert('فرم ثبت نام ارسال شد! (این یک دمو است)');
});
  </script>
</body>
</html>`
      : `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Register</title>
  <style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: system-ui, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
.register-card { background: rgba(255,255,255,0.05); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 3rem; width: 100%; max-width: 400px; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
.register-card h1 { text-align: center; margin-bottom: 0.5rem; background: linear-gradient(135deg, #FE03C3, #3794ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-size: 2rem; }
.register-card .subtitle { text-align: center; color: #aaa; margin-bottom: 2rem; }
.form-group { margin-bottom: 1.5rem; }
.form-group label { display: block; margin-bottom: 0.5rem; color: #ddd; font-size: 0.9rem; }
.form-group input { width: 100%; padding: 1rem; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #fff; font-family: inherit; font-size: 1rem; outline: none; transition: border-color 0.2s; }
.form-group input:focus { border-color: #FE03C3; }
.btn { width: 100%; padding: 1rem; background: linear-gradient(135deg, #FE03C3, #3794ff); border: none; border-radius: 8px; color: #fff; font-size: 1rem; font-family: inherit; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; }
.btn:hover { transform: translateY(-2px); box-shadow: 0 10px 20px rgba(254,3,195,0.3); }
.links { text-align: center; margin-top: 1.5rem; color: #888; }
.links a { color: #FE03C3; text-decoration: none; }
.links a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="register-card">
<h1>Create Your Account</h1>
<p class="subtitle">Sign up to get started</p>
<form id="registerForm">
  <div class="form-group">
    <label for="name">Full Name</label>
    <input type="text" id="name" name="name" required autocomplete="name" placeholder="Your full name">
  </div>
  <div class="form-group">
    <label for="email">Email</label>
    <input type="email" id="email" name="email" required autocomplete="email" placeholder="example@domain.com">
  </div>
  <div class="form-group">
    <label for="password">Password</label>
    <input type="password" id="password" name="password" required autocomplete="new-password" minlength="8" placeholder="At least 8 characters">
  </div>
  <div class="form-group">
    <label for="confirmPassword">Confirm Password</label>
    <input type="password" id="confirmPassword" name="confirmPassword" required autocomplete="new-password" placeholder="Confirm password">
  </div>
  <button type="submit" class="btn">Sign Up</button>
</form>
<div class="links">
  <a href="#">Already have an account? Sign In</a>
</div>
  </div>
  <script>
document.getElementById('registerForm').addEventListener('submit', function(e) {
  e.preventDefault();
  const pass = document.getElementById('password').value;
  const confirm = document.getElementById('confirmPassword').value;
  if (pass !== confirm) { alert('Passwords do not match'); return; }
  alert('Registration form submitted! (This is a demo)');
});
  </script>
</body>
</html>`;
  } else {
    // Generic HTML file with the user's suggested filename
    content = isFa
      ? `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${suggestedFilename.replace('.html', '')}</title>
  <style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Vazirmatn', sans-serif; background: #1a1a2e; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
.card { background: rgba(255,255,255,0.05); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 3rem; width: 100%; max-width: 600px; text-align: center; }
.card h1 { margin-bottom: 1rem; background: linear-gradient(135deg, #FE03C3, #3794ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.card p { color: #aaa; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
<h1>${suggestedFilename.replace('.html', '')}</h1>
<p>این فایل توسط Fibonacci Agent ساخته شده است. محتوای مورد نظر خود را در اینجا قرار دهید.</p>
  </div>
</body>
</html>`
      : `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${suggestedFilename.replace('.html', '')}</title>
  <style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
.card { background: rgba(255,255,255,0.05); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 3rem; width: 100%; max-width: 600px; text-align: center; }
.card h1 { margin-bottom: 1rem; background: linear-gradient(135deg, #FE03C3, #3794ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.card p { color: #aaa; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
<h1>${suggestedFilename.replace('.html', '')}</h1>
<p>This file was created by Fibonacci Agent. Add your content here.</p>
  </div>
</body>
</html>`;
  }
} else if (userText.includes('html') || userText.includes('صفحه') || userText.includes('landing') || userText.includes('سایت')) {
  filename = 'script.js';
  content = isFa
    ? `// یک ابزار کاربردی جاوااسکریپت — ماشین حساب ساده
// ساخته شده توسط Fibonacci Agent

class Calculator {
  constructor() {
this.history = [];
  }

  add(a, b) {
const result = a + b;
this.history.push(\`\${a} + \${b} = \${result}\`);
return result;
  }

  subtract(a, b) {
const result = a - b;
this.history.push(\`\${a} - \${b} = \${result}\`);
return result;
  }

  multiply(a, b) {
const result = a * b;
this.history.push(\`\${a} × \${b} = \${result}\`);
return result;
  }

  divide(a, b) {
if (b === 0) throw new Error('تقسیم بر صفر مجاز نیست');
const result = a / b;
this.history.push(\`\${a} ÷ \${b} = \${result}\`);
return result;
  }

  getHistory() {
return this.history;
  }
}

// استفاده
const calc = new Calculator();
console.log('2 + 3 =', calc.add(2, 3));
console.log('10 - 4 =', calc.subtract(10, 4));
console.log('5 × 6 =', calc.multiply(5, 6));
console.log('20 ÷ 4 =', calc.divide(20, 4));
console.log('تاریخچه:', calc.getHistory());
`
    : `// A useful JavaScript utility — Simple Calculator
// Created by Fibonacci Agent

class Calculator {
  constructor() {
this.history = [];
  }

  add(a, b) {
const result = a + b;
this.history.push(\`\${a} + \${b} = \${result}\`);
return result;
  }

  subtract(a, b) {
const result = a - b;
this.history.push(\`\${a} - \${b} = \${result}\`);
return result;
  }

  multiply(a, b) {
const result = a * b;
this.history.push(\`\${a} × \${b} = \${result}\`);
return result;
  }

  divide(a, b) {
if (b === 0) throw new Error('Division by zero is not allowed');
const result = a / b;
this.history.push(\`\${a} ÷ \${b} = \${result}\`);
return result;
  }

  getHistory() {
return this.history;
  }
}

// Usage
const calc = new Calculator();
console.log('2 + 3 =', calc.add(2, 3));
console.log('10 - 4 =', calc.subtract(10, 4));
console.log('5 × 6 =', calc.multiply(5, 6));
console.log('20 ÷ 4 =', calc.divide(20, 4));
console.log('History:', calc.getHistory());
`;
} else {
  // Default: Python utility
  filename = 'main.py';
  content = isFa
    ? `#!/usr/bin/env python3
"""
یک ابزار کاربردی پایتون — مدیریت لیست کارهای روزانه
ساخته شده توسط Fibonacci Agent
"""

import json
import os
from datetime import datetime
from pathlib import Path


class TaskManager:
"""مدیریت لیست کارهای روزانه با ذخیره‌سازی در فایل JSON."""

def __init__(self, filepath="tasks.json"):
    self.filepath = Path(filepath)
    self.tasks = self._load()

def _load(self):
    """بارگذاری کارها از فایل."""
    if self.filepath.exists():
        with open(self.filepath, "r", encoding="utf-8") as f:
            return json.load(f)
    return []

def _save(self):
    """ذخیره کارها در فایل."""
    with open(self.filepath, "w", encoding="utf-8") as f:
        json.dump(self.tasks, f, ensure_ascii=False, indent=2)

def add(self, title, priority="normal"):
    """افزودن کار جدید."""
    task = {
        "id": len(self.tasks) + 1,
        "title": title,
        "priority": priority,
        "done": False,
        "created_at": datetime.now().isoformat(),
    }
    self.tasks.append(task)
    self._save()
    return task

def complete(self, task_id):
    """تکمیل یک کار."""
    for task in self.tasks:
        if task["id"] == task_id:
            task["done"] = True
            task["completed_at"] = datetime.now().isoformat()
            self._save()
            return task
    return None

def list_tasks(self, show_done=True):
    """نمایش لیست کارها."""
    if show_done:
        return self.tasks
    return [t for t in self.tasks if not t["done"]]

def remove(self, task_id):
    """حذف یک کار."""
    before = len(self.tasks)
    self.tasks = [t for t in self.tasks if t["id"] != task_id]
    self._save()
    return len(self.tasks) < before

def summary(self):
    """خلاصه‌ای از کارها."""
    total = len(self.tasks)
    done = sum(1 for t in self.tasks if t["done"])
    pending = total - done
    return {
        "total": total,
        "done": done,
        "pending": pending,
        "progress": f"{(done / total * 100) if total else 0:.1f}%",
    }


def main():
"""تابع اصلی — نمایش قابلیت‌ها."""
tm = TaskManager()

# افزودن چند کار نمونه
tm.add("خرید مواد غذایی", "high")
tm.add("تمرین ورزش", "normal")
tm.add("مطالعه کتاب", "low")

# تکمیل یک کار
tm.complete(1)

# نمایش خلاصه
summary = tm.summary()
print("=" * 50)
print("📋  خلاصه کارهای روزانه")
print("=" * 50)
print(f"  کل کارها: {summary['total']}")
print(f"  انجام شده: {summary['done']}")
print(f"  باقی مانده: {summary['pending']}")
print(f"  پیشرفت: {summary['progress']}")
print("=" * 50)

# نمایش لیست کارها
print("\\n📝  لیست کارها:")
for task in tm.list_tasks():
    status = "✅" if task["done"] else "⬜"
    print(f"  {status} [{task['id']}] {task['title']} (اولویت: {task['priority']})")


if __name__ == "__main__":
main()
`
    : `#!/usr/bin/env python3
"""
A useful Python utility — Daily Task Manager
Created by Fibonacci Agent
"""

import json
import os
from datetime import datetime
from pathlib import Path


class TaskManager:
"""Manage daily tasks with JSON file storage."""

def __init__(self, filepath="tasks.json"):
    self.filepath = Path(filepath)
    self.tasks = self._load()

def _load(self):
    """Load tasks from file."""
    if self.filepath.exists():
        with open(self.filepath, "r", encoding="utf-8") as f:
            return json.load(f)
    return []

def _save(self):
    """Save tasks to file."""
    with open(self.filepath, "w", encoding="utf-8") as f:
        json.dump(self.tasks, f, ensure_ascii=False, indent=2)

def add(self, title, priority="normal"):
    """Add a new task."""
    task = {
        "id": len(self.tasks) + 1,
        "title": title,
        "priority": priority,
        "done": False,
        "created_at": datetime.now().isoformat(),
    }
    self.tasks.append(task)
    self._save()
    return task

def complete(self, task_id):
    """Complete a task."""
    for task in self.tasks:
        if task["id"] == task_id:
            task["done"] = True
            task["completed_at"] = datetime.now().isoformat()
            self._save()
            return task
    return None

def list_tasks(self, show_done=True):
    """List tasks."""
    if show_done:
        return self.tasks
    return [t for t in self.tasks if not t["done"]]

def remove(self, task_id):
    """Remove a task."""
    before = len(self.tasks)
    self.tasks = [t for t in self.tasks if t["id"] != task_id]
    self._save()
    return len(self.tasks) < before

def summary(self):
    """Summary of tasks."""
    total = len(self.tasks)
    done = sum(1 for t in self.tasks if t["done"])
    pending = total - done
    return {
        "total": total,
        "done": done,
        "pending": pending,
        "progress": f"{(done / total * 100) if total else 0:.1f}%",
    }


def main():
"""Main function — demo capabilities."""
tm = TaskManager()

# Add sample tasks
tm.add("Buy groceries", "high")
tm.add("Exercise", "normal")
tm.add("Read a book", "low")

# Complete a task
tm.complete(1)

# Show summary
summary = tm.summary()
print("=" * 50)
print("📋  Daily Task Summary")
print("=" * 50)
print(f"  Total tasks: {summary['total']}")
print(f"  Completed: {summary['done']}")
print(f"  Pending: {summary['pending']}")
print(f"  Progress: {summary['progress']}")
print("=" * 50)

# List tasks
print("\\n📝  Task List:")
for task in tm.list_tasks():
    status = "✅" if task["done"] else "⬜"
    print(f"  {status} [{task['id']}] {task['title']} (priority: {task['priority']})")


if __name__ == "__main__":
main();
`;
}


  return { filename, content };
}
