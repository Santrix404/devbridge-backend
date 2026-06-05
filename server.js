const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const PDFDocument = require('pdfkit');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});
app.use(cors());
app.use(express.json());

// Diagnostic endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    ip_allowed: '0.0.0.0 (Global Access)'
  });
});

// Request logger for debugging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Serve static files from uploads folder
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authorization token required' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });

    db.query('SELECT id, name, email, role, is_active FROM users WHERE id = ?', [decoded.id], (dbErr, results) => {
      if (dbErr) return res.status(500).json({ error: dbErr.message });
      if (results.length === 0) return res.status(401).json({ error: 'Invalid token user' });
      const user = results[0];
      if (user.is_active === 0) return res.status(403).json({ error: 'Account inactive. Contact support.' });
      req.user = user;
      next();
    });
  });
};

const requireAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
};

// Configure Multer for storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    let safeName = file.originalname || 'upload.bin';
    try {
      if (file.originalname) safeName = decodeURIComponent(file.originalname);
    } catch (e) {}
    safeName = safeName.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, Date.now() + '-' + safeName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit for APK/EXE/ZIP
});

// Database connection
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'devbridge_db',
  port: 61001
});

db.connect((err) => {
  if (err) {
    console.error('Error connecting to MySQL:', err);
    return;
  }
  console.log('Connected to MySQL database.');

  // Migration: Add bio and skills columns if they don't exist
  db.query("SHOW COLUMNS FROM users LIKE 'bio'", (bErr, bRes) => {
    if (!bErr && bRes.length === 0) {
      db.query("ALTER TABLE users ADD COLUMN bio TEXT", (alterErr) => {
        if (alterErr) console.error('Migration error (add bio):', alterErr);
        else console.log('Successfully added bio column to users table.');
      });
    }
  });

  db.query("SHOW COLUMNS FROM users LIKE 'skills'", (sErr, sRes) => {
    if (!sErr && sRes.length === 0) {
      db.query("ALTER TABLE users ADD COLUMN skills TEXT", (alterErr) => {
        if (alterErr) console.error('Migration error (add skills):', alterErr);
        else console.log('Successfully added skills column to users table.');
      });
    }
  });

  // Migration: Add PRD columns to ideas table if they don't exist
  db.query("SHOW COLUMNS FROM ideas LIKE 'prd_design'", (err, res) => {
    if (!err && res.length === 0) {
      db.query("ALTER TABLE ideas ADD COLUMN prd_design TEXT, ADD COLUMN prd_color VARCHAR(255), ADD COLUMN prd_features TEXT, ADD COLUMN prd_price VARCHAR(100)", (alterErr) => {
        if (alterErr) console.error('Migration error (add prd columns to ideas):', alterErr);
        else {
          console.log('Successfully added PRD columns to ideas table.');
          db.query("UPDATE ideas SET prd_design = 'Konsep UI/UX modern dengan Clean Glassmorphism, layout 5 tab utama, mendukung caching luring.', prd_color = 'Biru Royal (#0066CC), Putih Bersih, dan Slate (#475569)', prd_features = '1. Autentikasi JWT & Role-Based Access\\n2. Fitur pembayaran QRIS otomatis\\n3. Dasbor analisis grafik performa real-time', prd_price = '15,000,000' WHERE prd_design IS NULL");
        }
      });
    } else if (!err) {
      // If columns already exist, populate mock data for existing ideas that have NULL prd_design
      db.query("UPDATE ideas SET prd_design = 'Konsep UI/UX modern dengan Clean Glassmorphism, layout 5 tab utama, mendukung caching luring.', prd_color = 'Biru Royal (#0066CC), Putih Bersih, dan Slate (#475569)', prd_features = '1. Autentikasi JWT & Role-Based Access\\n2. Fitur pembayaran QRIS otomatis\\n3. Dasbor analisis grafik performa real-time', prd_price = '15,000,000' WHERE prd_design IS NULL");
    }
  });

  // Migration: Add role column if not exists
  const addRoleSql = "ALTER TABLE users ADD COLUMN IF NOT EXISTS role ENUM('user', 'admin') DEFAULT 'user'";
  db.query(addRoleSql, (err) => {
    if (err) {
      if (err.code === 'ER_PARSE_ERROR' || err.code === 'ER_BAD_TABLE_ERROR') {
        // Fallback for older MySQL that doesn't support ADD COLUMN IF NOT EXISTS
        db.query("SHOW COLUMNS FROM users LIKE 'role'", (cErr, cRes) => {
          if (!cErr && cRes.length === 0) {
            db.query("ALTER TABLE users ADD COLUMN role ENUM('user', 'admin') DEFAULT 'user'");
          }
        });
      } else {
        console.error('Migration error (role):', err);
      }
    }
  });

  db.query("SHOW COLUMNS FROM users LIKE 'is_active'", (activeErr, activeRes) => {
    if (!activeErr && activeRes.length === 0) {
      db.query("ALTER TABLE users ADD COLUMN is_active TINYINT(1) DEFAULT 1", (alterErr) => {
        if (alterErr) console.error('Migration error (is_active):', alterErr);
        else console.log('Successfully added is_active column to users table.');
      });
    }
  });

  db.query("SHOW COLUMNS FROM users LIKE 'reset_otp'", (otpErr, otpRes) => {
    if (!otpErr && otpRes.length === 0) {
      db.query("ALTER TABLE users ADD COLUMN reset_otp VARCHAR(10), ADD COLUMN reset_otp_expires DATETIME", (alterErr) => {
        if (alterErr) console.error('Migration error (reset_otp):', alterErr);
        else console.log('Successfully added reset_otp columns to users table.');
      });
    }
  });

  db.query("SHOW COLUMNS FROM users LIKE 'profile_picture'", (picErr, picRes) => {
    if (!picErr && picRes.length === 0) {
      db.query("ALTER TABLE users ADD COLUMN profile_picture VARCHAR(255)", (alterErr) => {
        if (alterErr) console.error('Migration error (profile_picture):', alterErr);
        else console.log('Successfully added profile_picture column to users table.');
      });
    }
  });

  // Migration: Add applications table if not exists
  const createAppsTable = `
    CREATE TABLE IF NOT EXISTS applications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      type ENUM('idea', 'project') NOT NULL,
      target_id INT NOT NULL,
      status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
      message TEXT,
      proposal_url VARCHAR(255),
      attachment_url VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `;
  db.query(createAppsTable, (err) => {
    if (err) console.error('Migration error (applications):', err);

    // Ensure columns exist for existing tables
    const addProposalCol = "ALTER TABLE applications ADD COLUMN IF NOT EXISTS proposal_url VARCHAR(255)";
    const addAttachmentCol = "ALTER TABLE applications ADD COLUMN IF NOT EXISTS attachment_url VARCHAR(255)";
    const addUpdatedAtCol = "ALTER TABLE applications ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP";
    db.query(addProposalCol);
    db.query(addAttachmentCol);
    db.query(addUpdatedAtCol);

    // Ensure VARCHAR column for status to support PRD & Payment flows
    const alterStatusType = "ALTER TABLE applications MODIFY COLUMN status VARCHAR(50) DEFAULT 'pending'";
    db.query(alterStatusType, (alterErr) => {
      if (alterErr) console.error('Migration error (applications alter status):', alterErr);
      
      // Add PRD & monitoring columns
      db.query("ALTER TABLE applications ADD COLUMN IF NOT EXISTS prd_design TEXT");
      db.query("ALTER TABLE applications ADD COLUMN IF NOT EXISTS prd_color VARCHAR(255)");
      db.query("ALTER TABLE applications ADD COLUMN IF NOT EXISTS prd_features TEXT");
      db.query("ALTER TABLE applications ADD COLUMN IF NOT EXISTS prd_price VARCHAR(100)");
      db.query("ALTER TABLE applications ADD COLUMN IF NOT EXISTS duration_months INT DEFAULT 1");
      db.query("ALTER TABLE applications ADD COLUMN IF NOT EXISTS monitoring_type VARCHAR(20) DEFAULT 'Mingguan'");
      db.query("ALTER TABLE applications ADD COLUMN IF NOT EXISTS rating INT DEFAULT 0");
      db.query("ALTER TABLE applications ADD COLUMN IF NOT EXISTS finished_at TIMESTAMP NULL DEFAULT NULL");
      console.log('Successfully completed PRD & Monitoring table migrations.');
    });
  });

  // Migration: Add notifications table if not exists
  const createNotificationsTable = `
    CREATE TABLE IF NOT EXISTS notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      type ENUM('system', 'payment', 'update') DEFAULT 'system',
      title VARCHAR(255) NOT NULL,
      message TEXT,
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `;
  db.query(createNotificationsTable, (err) => {
    if (err) console.error('Migration error (notifications):', err);
  });

  // Migration: Add messages table if not exists
  const createMessagesTable = `
    CREATE TABLE IF NOT EXISTS messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sender_id INT,
      receiver_id INT,
      message TEXT NOT NULL,
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `;
  db.query(createMessagesTable, (err) => {
    if (err) console.error('Migration error (messages):', err);
    else console.log('Successfully initialized messages table in database.');
  });

  // Migration: Add project_reports table
  const createReportsTable = `
    CREATE TABLE IF NOT EXISTS project_reports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      application_id INT NOT NULL,
      week_number INT NOT NULL,
      report_text TEXT,
      document_url VARCHAR(255),
      image_url VARCHAR(255),
      app_file_url VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
    )
  `;
  db.query(createReportsTable, (err) => {
    if (err) console.error('Migration error (project_reports):', err);
    else {
      console.log('Successfully initialized project_reports table in database.');
      db.query("ALTER TABLE project_reports ADD COLUMN IF NOT EXISTS app_file_url VARCHAR(255)");
      db.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS app_file_url VARCHAR(255)");
      db.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS app_file_name VARCHAR(255)");
    }
  });

  // Migration: Add user_reports table for bug reports and monitoring issues
  const createUserReportsTable = `
    CREATE TABLE IF NOT EXISTS user_reports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      application_id INT NULL,
      report_type ENUM('bug','monitoring_issue') NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      status ENUM('open','resolved','canceled') DEFAULT 'open',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMP NULL DEFAULT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE SET NULL
    )
  `;
  db.query(createUserReportsTable, (err) => {
    if (err) console.error('Migration error (user_reports):', err);
    else console.log('Successfully initialized user_reports table in database.');
  });

  // Auto-finish cron job: Runs every 1 hour (3600000 ms)
  setInterval(() => {
    const autoFinishSql = `
      UPDATE applications a
      JOIN project_reports pr ON a.id = pr.application_id
      SET a.status = 'finished', a.rating = 5, a.finished_at = NOW()
      WHERE a.status = 'completed' AND pr.app_file_url IS NOT NULL AND pr.created_at < NOW() - INTERVAL 3 DAY
    `;
    db.query(autoFinishSql, (err, result) => {
      if (err) console.error('Auto-finish cron error:', err);
      else if (result.affectedRows > 0) {
        console.log(`[Auto-Finish] Successfully finished ${result.affectedRows} projects automatically.`);
      }
    });

    const selectExpiredPaymentsSql = `
      SELECT a.id, a.user_id, a.type, COALESCE(i.title, p.title) AS title
      FROM applications a
      LEFT JOIN ideas i ON a.target_id = i.id AND a.type = 'idea'
      LEFT JOIN projects p ON a.target_id = p.id AND a.type = 'project'
      WHERE a.status = 'payment_submitted' AND a.updated_at < NOW() - INTERVAL 24 HOUR
    `;
    db.query(selectExpiredPaymentsSql, (selectErr, rows) => {
      if (selectErr) {
        console.error('Auto-cancel select error:', selectErr);
        return;
      }
      if (rows.length === 0) return;

      const paymentIds = rows.map((row) => row.id);
      db.query('UPDATE applications SET status = ? WHERE id IN (?)', ['canceled', paymentIds], (updateErr, updateResult) => {
        if (updateErr) {
          console.error('Auto-cancel cron error:', updateErr);
          return;
        }
        console.log(`[Auto-Cancel] Automatically canceled ${updateResult.affectedRows} pending payments.`);
        rows.forEach((row) => {
          const title = 'Pembayaran Dibatalkan Otomatis';
          const message = `Pembayaran untuk '${row.title}' dibatalkan otomatis karena admin belum mengonfirmasi dalam 24 jam.`;
          db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [row.user_id, 'payment', title, message], (insertErr) => {
            if (insertErr) console.error('Auto-cancel notification error:', insertErr);
          });
        });
      });
    });
  }, 3600000);
});

// --- Auth Endpoints ---

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const sql = 'INSERT INTO users (name, email, password) VALUES (?, ?, ?)';
    db.query(sql, [name, email, hashedPassword], (err, results) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already exists' });
        return res.status(500).json({ error: err.message });
      }
      res.status(201).json({ message: 'User registered successfully' });
    });
  } catch (err) {
    res.status(500).json({ error: 'Encryption error' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const sql = 'SELECT * FROM users WHERE email = ?';
  db.query(sql, [email], async (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results.length === 0) return res.status(404).json({ error: 'User not found' });

    const user = results[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.is_active === 0) return res.status(403).json({ error: 'Account inactive. Contact support.' });
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role || 'user',
        is_active: user.is_active === 1,
        bio: user.bio || '',
        skills: user.skills || '',
        profile_picture: user.profile_picture || null
      }
    });
  });
});

app.post('/api/auth/forgot-password', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  db.query('SELECT id FROM users WHERE email = ?', [email], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results.length === 0) return res.status(404).json({ error: 'Email tidak ditemukan' });

    const otp = Math.floor(1000 + Math.random() * 9000).toString(); // 4 digit
    const expires = new Date(Date.now() + 15 * 60000); // 15 menit

    db.query('UPDATE users SET reset_otp = ?, reset_otp_expires = ? WHERE email = ?', [otp, expires, email], (upErr) => {
      if (upErr) return res.status(500).json({ error: upErr.message });
      
      console.log(`[MOCK EMAIL] OTP for ${email} is: ${otp}`);
      res.json({ message: 'OTP terkirim', otp: otp });
    });
  });
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email dan OTP required' });

  db.query('SELECT reset_otp, reset_otp_expires FROM users WHERE email = ?', [email], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results.length === 0) return res.status(404).json({ error: 'User tidak ditemukan' });

    const user = results[0];
    if (user.reset_otp !== otp) return res.status(400).json({ error: 'OTP salah' });
    if (new Date(user.reset_otp_expires) < new Date()) return res.status(400).json({ error: 'OTP kadaluarsa' });

    res.json({ message: 'OTP valid' });
  });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword) return res.status(400).json({ error: 'Data tidak lengkap' });

  db.query('SELECT reset_otp, reset_otp_expires FROM users WHERE email = ?', [email], async (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results.length === 0) return res.status(404).json({ error: 'User tidak ditemukan' });

    const user = results[0];
    if (user.reset_otp !== otp) return res.status(400).json({ error: 'OTP salah' });
    if (new Date(user.reset_otp_expires) < new Date()) return res.status(400).json({ error: 'OTP kadaluarsa' });

    try {
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      db.query('UPDATE users SET password = ?, reset_otp = NULL, reset_otp_expires = NULL WHERE email = ?', [hashedPassword, email], (upErr) => {
        if (upErr) return res.status(500).json({ error: upErr.message });
        res.json({ message: 'Password berhasil direset' });
      });
    } catch (hashErr) {
      res.status(500).json({ error: 'Gagal mengenkripsi password' });
    }
  });
});

app.use('/api/admin', authenticateToken, requireAdmin);

app.get('/api/admin/users', (req, res) => {
  db.query('SELECT id, name, email, role, is_active, created_at FROM users ORDER BY created_at DESC', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.get('/api/admin/users/:id', (req, res) => {
  db.query('SELECT id, name, email, role, is_active, created_at FROM users WHERE id = ?', [req.params.id], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(results[0]);
  });
});

app.put('/api/admin/users/:id/status', (req, res) => {
  const { role, is_active } = req.body;
  const updates = [];
  const values = [];
  if (role && ['user', 'admin'].includes(role)) {
    updates.push('role = ?');
    values.push(role);
  }
  if (typeof is_active !== 'undefined') {
    updates.push('is_active = ?');
    values.push(is_active ? 1 : 0);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'role or is_active required' });

  const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
  values.push(req.params.id);
  db.query(sql, values, (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'User status updated successfully' });
  });
});

app.get('/api/admin/projects', (req, res) => {
  const sql = `SELECT p.*, u.name AS owner_name, u.email AS owner_email FROM projects p LEFT JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.get('/api/admin/projects/:id', (req, res) => {
  const sql = `SELECT p.*, u.name AS owner_name, u.email AS owner_email FROM projects p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?`;
  db.query(sql, [req.params.id], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json(results[0]);
  });
});

app.put('/api/admin/projects/:id/approve', (req, res) => {
  const projectId = req.params.id;
  db.query('SELECT p.user_id, p.title FROM projects p WHERE p.id = ?', [projectId], (selErr, selRes) => {
    if (selErr) return res.status(500).json({ error: selErr.message });
    if (selRes.length === 0) return res.status(404).json({ error: 'Project not found' });

    db.query('UPDATE projects SET status = ? WHERE id = ?', ['approved', projectId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      const ownerId = selRes[0].user_id;
      db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [
        ownerId,
        'admin',
        'Proyek Disetujui',
        `Proyek '${selRes[0].title}' telah disetujui oleh admin dan kini aktif di marketplace.`
      ]);
      res.json({ message: 'Project approved successfully' });
    });
  });
});

app.delete('/api/admin/projects/:id', (req, res) => {
  db.query('DELETE FROM projects WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Project deleted successfully' });
  });
});

app.get('/api/admin/ideas', (req, res) => {
  const sql = `SELECT i.*, u.name AS owner_name, u.email AS owner_email FROM ideas i LEFT JOIN users u ON i.user_id = u.id ORDER BY i.created_at DESC`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.put('/api/admin/ideas/:id/approve', (req, res) => {
  const ideaId = req.params.id;
  db.query('SELECT user_id, title FROM ideas WHERE id = ?', [ideaId], (selErr, selRes) => {
    if (selErr) return res.status(500).json({ error: selErr.message });
    if (selRes.length === 0) return res.status(404).json({ error: 'Idea not found' });

    db.query('UPDATE ideas SET status = ? WHERE id = ?', ['approved', ideaId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [
        selRes[0].user_id,
        'admin',
        'Ide Disetujui',
        `Ide '${selRes[0].title}' telah disetujui oleh admin dan siap ditawarkan di marketplace.`
      ]);
      res.json({ message: 'Idea approved successfully' });
    });
  });
});

app.delete('/api/admin/ideas/:id', (req, res) => {
  db.query('DELETE FROM ideas WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Idea deleted successfully' });
  });
});

app.get('/api/admin/payments', (req, res) => {
  const sql = `SELECT a.*, u.name AS buyer_name, u.email AS buyer_email,
               COALESCE(p.title, i.title) AS payment_title,
               COALESCE(p.budget, i.budget, a.bid_price, a.prd_price) AS payment_amount,
               a.type AS payment_type,
               p.app_file_url, p.app_file_name
               FROM applications a
               LEFT JOIN users u ON a.user_id = u.id
               LEFT JOIN projects p ON a.target_id = p.id AND a.type = 'project'
               LEFT JOIN ideas i ON a.target_id = i.id AND a.type = 'idea'
               ORDER BY a.created_at DESC`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.get('/api/admin/sales', (req, res) => {
  const sql = `SELECT a.id, a.user_id AS buyer_id, u.name AS buyer_name, u.email AS buyer_email, p.id AS project_id, p.title AS project_title, p.budget AS project_budget, a.status, a.bid_price, a.approved_at, a.created_at
               FROM applications a
               LEFT JOIN users u ON a.user_id = u.id
               LEFT JOIN projects p ON a.target_id = p.id
               WHERE a.type = 'project' AND a.status IN ('confirmed', 'completed', 'finished')
               ORDER BY a.approved_at DESC, a.created_at DESC`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.get('/api/admin/user-reports', (req, res) => {
  const sql = `SELECT r.*, u.name AS reporter_name, u.email AS reporter_email, a.type AS app_type, a.target_id AS app_target_id, p.title AS project_title, i.title AS idea_title
               FROM user_reports r
               LEFT JOIN users u ON r.user_id = u.id
               LEFT JOIN applications a ON r.application_id = a.id
               LEFT JOIN projects p ON a.target_id = p.id AND a.type = 'project'
               LEFT JOIN ideas i ON a.target_id = i.id AND a.type = 'idea'
               ORDER BY r.created_at DESC`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.put('/api/admin/user-reports/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['open','resolved','canceled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.query("UPDATE user_reports SET status = ?, resolved_at = CASE WHEN ? = 'resolved' THEN NOW() ELSE resolved_at END WHERE id = ?", [status, status, req.params.id], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Report status updated successfully' });
  });
});

app.put('/api/admin/applications/:id/cancel', (req, res) => {
  const { id } = req.params;
  db.query("SELECT a.*, p.user_id as project_owner, p.title as project_title, u.name as buyer_name FROM applications a LEFT JOIN projects p ON a.target_id = p.id AND a.type = 'project' LEFT JOIN users u ON a.user_id = u.id WHERE a.id = ?", [id], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results.length === 0) return res.status(404).json({ error: 'Application not found' });

    const app = results[0];
    db.query('UPDATE applications SET status = ? WHERE id = ?', ['canceled', id], (upErr) => {
      if (upErr) return res.status(500).json({ error: upErr.message });

      const messageForBuyer = `Proyek '${app.project_title || app.id}' dibatalkan oleh admin. Mohon cek detail untuk status terbaru.`;
      db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [app.user_id, 'update', 'Proyek Dibatalkan', messageForBuyer]);

      if (app.project_owner) {
        const messageForOwner = `Penjualan proyek '${app.project_title}' telah dibatalkan oleh admin. Silakan cek riwayat aplikasi untuk detail.`;
        db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [app.project_owner, 'update', 'Penjualan Dibatalkan', messageForOwner]);
      }

      res.json({ message: 'Application canceled successfully' });
    });
  });
});

app.post('/api/admin/notifications', (req, res) => {
  const { id } = req.params;
  db.query('SELECT a.*, p.user_id as owner_id, p.title FROM applications a LEFT JOIN projects p ON a.target_id = p.id WHERE a.id = ?', [id], (err, results) => {
    if (err || results.length === 0) return res.status(404).json({ error: 'Application not found' });
    const appRecord = results[0];

    db.query('UPDATE applications SET status = ? WHERE id = ?', ['confirmed', id], (upErr) => {
      if (upErr) return res.status(500).json({ error: upErr.message });

      const buyerNotification = [
        appRecord.user_id,
        'payment',
        'Pembayaran Dikonfirmasi',
        `Pembayaran untuk proyek '${appRecord.title}' telah dikonfirmasi. Proyek sekarang tersedia di tab Dibeli.`
      ];
      db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', buyerNotification);

      if (appRecord.owner_id) {
        db.query('SELECT name FROM users WHERE id = ?', [appRecord.user_id], (uErr, uRes) => {
          const buyerName = (!uErr && uRes.length > 0) ? uRes[0].name : 'Pengguna';
          db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [
            appRecord.owner_id,
            'payment',
            'Proyek Anda Terjual',
            `Proyek '${appRecord.title}' telah dibeli oleh ${buyerName}. Cek tab Terjual untuk detail.`
          ]);
        });
      }

      res.json({ message: 'Payment confirmed and buyer notified' });
    });
  });
});

app.put('/api/admin/payments/:id/reject', (req, res) => {
  db.query('UPDATE applications SET status = ? WHERE id = ?', ['rejected', req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Payment rejected successfully' });
  });
});

app.put('/api/admin/payments/:id/confirm', (req, res) => {
  const { id } = req.params;
  
  db.query('SELECT a.*, CASE WHEN a.type = "idea" THEN i.title ELSE p.title END as title FROM applications a LEFT JOIN ideas i ON a.target_id = i.id AND a.type = "idea" LEFT JOIN projects p ON a.target_id = p.id AND a.type = "project" WHERE a.id = ?', [id], (err, results) => {
    if (err || results.length === 0) return res.status(404).json({ error: 'Application not found' });
    
    const app = results[0];
    const sql = "UPDATE applications SET status = 'confirmed' WHERE id = ?";
    db.query(sql, [id], (upErr) => {
      if (upErr) return res.status(500).json({ error: upErr.message });
      
      // Notify the applicant (buyer/creator) that payment is confirmed
      const notifTitle = 'Pembayaran Dikonfirmasi!';
      const notifMsg = app.type === 'project'
        ? `Pembayaran untuk proyek '${app.title}' telah dikonfirmasi. File proyek kini dapat diunduh di tab "Dibeli" pada menu Monitoring!`
        : `Pembayaran untuk '${app.title}' telah dikonfirmasi oleh Admin. Project telah resmi masuk tahap monitoring!`;
      db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [
        app.user_id,
        'payment',
        notifTitle,
        notifMsg
      ]);
      
      // If project purchase, notify the project owner (seller) about the sale
      if (app.type === 'project') {
        db.query('SELECT p.user_id as owner_id FROM projects p WHERE p.id = ?', [app.target_id], (ownerErr, ownerRes) => {
          if (!ownerErr && ownerRes.length > 0 && ownerRes[0].owner_id) {
            db.query('SELECT name FROM users WHERE id = ?', [app.user_id], (uErr, uRes) => {
              const buyerName = (!uErr && uRes.length > 0) ? uRes[0].name : 'Pengguna';
              db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [
                ownerRes[0].owner_id,
                'payment',
                'Proyek Anda Terjual!',
                `Proyek '${app.title}' telah dibeli oleh ${buyerName}. Cek tab Terjual di menu Monitoring untuk detail.`
              ]);
            });
          }
        });
      }
      
      res.json({ message: 'Payment confirmed successfully. Project is now active!' });
    });
  });
});

app.post('/api/admin/notifications', (req, res) => {
  const { user_id, type, title, message } = req.body;
  if (!user_id || !title || !message) return res.status(400).json({ error: 'User ID, title, and message required' });
  db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [user_id, type || 'admin', title, message], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id: results.insertId, message: 'Notification created' });
  });
});

app.get('/api/admin/notifications', (req, res) => {
  const sql = 'SELECT id, type, title, message, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC';
  db.query(sql, [req.user.id], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// GET user profile by ID
app.get('/api/users/:id', (req, res) => {
  const userId = req.params.id;
  const sql = 'SELECT id, name, email, bio, skills, role, profile_picture FROM users WHERE id = ?';
  db.query(sql, [userId], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(results[0]);
  });
});

// Update user profile by ID
app.put('/api/users/:id', (req, res) => {
  const userId = req.params.id;
  const { name, email, bio, skills } = req.body;
  
  const sql = 'UPDATE users SET name = ?, email = ?, bio = ?, skills = ? WHERE id = ?';
  db.query(sql, [name, email, bio, skills, userId], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Profile updated successfully' });
  });
});

// Upload User Avatar
app.post('/api/users/:id/avatar', upload.single('avatar'), (req, res) => {
  const userId = req.params.id;
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  const profilePictureUrl = `/uploads/${req.file.filename}`;
  db.query('UPDATE users SET profile_picture = ? WHERE id = ?', [profilePictureUrl, userId], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Avatar updated', profile_picture: profilePictureUrl });
  });
});

// Upload Chat Image
app.post('/api/chat/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const imageUrl = `/uploads/${req.file.filename}`;
  res.json({ image_url: imageUrl });
});


// --- IDEAS API ---

app.post('/api/ideas', upload.any(), (req, res) => {
  console.log('--- NEW IDEA UPLOAD ---');
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('Files:', req.files?.map(f => ({ name: f.fieldname, original: f.originalname, size: f.size })));

  const { title, description, budget, prd_design, prd_color, prd_features, prd_price, sectors, user_id } = req.body;

  if (!title || !description) {
    return res.status(400).json({ error: 'Title and description required' });
  }

  const firstImageUrl = req.files && req.files.length > 0 ? `/uploads/${req.files[0].filename}` : '';

  db.query(
    'INSERT INTO ideas (title, description, budget, image_url, user_id, prd_design, prd_color, prd_features, prd_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [title, description, budget, firstImageUrl, user_id, prd_design || null, prd_color || null, prd_features || null, prd_price || null],
    (err, results) => {
      if (err) {
        console.error('DATABASE ERROR (Ideas Insert):', err);
        return res.status(500).json({ error: `Database Error: ${err.message}` });
      }

      const ideaId = results.insertId;
      console.log('Idea saved with ID:', ideaId);

      // Handle Multiple Images
      if (req.files && req.files.length > 0) {
        req.files.forEach(file => {
          const imgUrl = `/uploads/${file.filename}`;
          db.query('INSERT INTO idea_images (idea_id, image_url) VALUES (?, ?)', [ideaId, imgUrl], (imgErr) => {
            if (imgErr) console.error('DATABASE ERROR (Idea Image Insert):', imgErr);
          });
        });
      }

      // Handle Sectors
      if (sectors) {
        try {
          const sectorArr = typeof sectors === 'string' ? JSON.parse(sectors) : sectors;
          if (Array.isArray(sectorArr)) {
            sectorArr.forEach(sName => {
              db.query('INSERT IGNORE INTO sectors (name) VALUES (?)', [sName], (sErr) => {
                if (sErr) return console.error('DATABASE ERROR (Sector Insert):', sErr);

                db.query('SELECT id FROM sectors WHERE name = ?', [sName], (selErr, sRes) => {
                  if (selErr) return console.error('DATABASE ERROR (Sector Select):', selErr);

                  if (sRes && sRes.length > 0) {
                    db.query('INSERT IGNORE INTO idea_sectors (idea_id, sector_id) VALUES (?, ?)', [ideaId, sRes[0].id], (isErr) => {
                      if (isErr) console.error('DATABASE ERROR (Idea Sector Insert):', isErr);
                    });
                  }
                });
              });
            });
          }
        } catch (parseErr) {
          console.error('JSON PARSE ERROR (Sectors):', parseErr);
          // Don't fail the whole request, but log it
        }
      }

      res.status(201).json({
        id: ideaId,
        message: 'Idea submitted successfully',
        warning: sectors && typeof sectors === 'string' && sectors.startsWith('{') ? 'Sectors expected as array' : null
      });
    }
  );
});

// --- PROJECTS API ---

app.post('/api/projects', upload.any(), (req, res) => {
  const { title, description, budget, sectors, user_id } = req.body;

  // Extract files by fieldname for robustness in React Native
  const thumbnailFile = req.files?.find(f => f.fieldname === 'thumbnail');
  const galleryFiles = req.files?.filter(f => f.fieldname === 'gallery') || [];
  const documentFiles = req.files?.filter(f => f.fieldname === 'documents') || [];
  const appFile = req.files?.find(f => f.fieldname === 'app_file');

  const thumbnail_url = thumbnailFile ? `/uploads/${thumbnailFile.filename}` : null;
  const app_file_url = appFile ? `/uploads/${appFile.filename}` : null;
  const app_file_name = appFile ? appFile.originalname : null;

  if (!title || !description) return res.status(400).json({ error: 'Title and description required' });

  db.query(
    'INSERT INTO projects (title, description, budget, thumbnail_url, user_id, app_file_url, app_file_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [title, description, budget, thumbnail_url, user_id, app_file_url, app_file_name],
    (err, results) => {
      if (err) return res.status(500).json({ error: err.message });
      const projectId = results.insertId;

      // Gallery Images
      if (galleryFiles.length > 0) {
        galleryFiles.forEach(file => {
          db.query('INSERT INTO project_gallery (project_id, image_url) VALUES (?, ?)', [projectId, `/uploads/${file.filename}`]);
        });
      }

      // Documents
      if (documentFiles.length > 0) {
        documentFiles.forEach(file => {
          db.query('INSERT INTO project_documents (project_id, file_url, file_name) VALUES (?, ?, ?)',
            [projectId, `/uploads/${file.filename}`, file.originalname]);
        });
      }

      // Sectors
      if (sectors) {
        try {
          const sectorArr = typeof sectors === 'string' ? JSON.parse(sectors) : sectors;
          if (Array.isArray(sectorArr)) {
            sectorArr.forEach(sName => {
              db.query('INSERT IGNORE INTO sectors (name) VALUES (?)', [sName], (err) => {
                if (err) console.error('Sector insert error:', err);
                db.query('SELECT id FROM sectors WHERE name = ?', [sName], (err, sRes) => {
                  if (err) console.error('Sector fetch error:', err);
                  if (sRes && sRes.length > 0) {
                    db.query('INSERT IGNORE INTO project_sectors (project_id, sector_id) VALUES (?, ?)', [projectId, sRes[0].id], (err) => {
                      if (err) console.error('Project sector link error:', err);
                    });
                  }
                });
              });
            });
          }
        } catch (e) {
          console.error('Error parsing sectors:', e);
        }
      }
      res.status(201).json({ id: projectId, message: 'Project submitted successfully' });
    }
  );
});

app.get('/api/ideas', (req, res) => {
  const sql = `
    SELECT i.*, u.name as owner_name, u.bio as owner_bio, u.skills as owner_skills,
           GROUP_CONCAT(DISTINCT s.name) AS sectorNames,
           GROUP_CONCAT(DISTINCT img.image_url) AS allImages
    FROM ideas i
    LEFT JOIN users u ON i.user_id = u.id
    LEFT JOIN idea_sectors isec ON i.id = isec.idea_id
    LEFT JOIN sectors s ON isec.sector_id = s.id
    LEFT JOIN idea_images img ON i.id = img.idea_id
    WHERE i.status = 'approved'
    GROUP BY i.id
    ORDER BY i.created_at DESC
  `;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });

    // Map results to ensure allImages is an array
    const mappedResults = results.map(row => ({
      ...row,
      images: row.allImages ? row.allImages.split(',') : []
    }));

    res.json(mappedResults);
  });
});

app.get('/api/projects', (req, res) => {
  const sql = `
    SELECT p.*, u.name as owner_name, u.bio as owner_bio, u.skills as owner_skills,
           GROUP_CONCAT(DISTINCT s.name) AS sectorNames,
           GROUP_CONCAT(DISTINCT pg.image_url) AS galleryImages,
           GROUP_CONCAT(DISTINCT CONCAT(pd.file_name, '::', pd.file_url)) AS documentFiles
    FROM projects p
    LEFT JOIN users u ON p.user_id = u.id
    LEFT JOIN project_sectors psec ON p.id = psec.project_id
    LEFT JOIN sectors s ON psec.sector_id = s.id
    LEFT JOIN project_gallery pg ON p.id = pg.project_id
    LEFT JOIN project_documents pd ON p.id = pd.project_id
    WHERE p.status = 'approved'
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });

    // Map to split concatenated values
    const mapped = results.map(row => {
      const { app_file_url, app_file_name, ...rest } = row;
      return {
        ...rest,
        gallery: row.galleryImages ? row.galleryImages.split(',') : [],
        documents: row.documentFiles ? row.documentFiles.split(',').map(d => {
          const [name, url] = d.split('::');
          return { name, url };
        }) : []
      };
    });

    res.json(mapped);
  });
});

// --- PURCHASED / SOLD PROJECTS API ---

// Get projects purchased by user (buyer)
app.get('/api/projects/purchased/:userId', (req, res) => {
  const { userId } = req.params;
  const sql = `
    SELECT a.id as application_id, a.status, a.created_at as purchased_at,
           p.id as project_id, p.title, p.description, p.budget, p.thumbnail_url,
           p.app_file_url, p.app_file_name,
           u.name as owner_name
    FROM applications a
    INNER JOIN projects p ON a.target_id = p.id AND a.type = 'project'
    LEFT JOIN users u ON p.user_id = u.id
    WHERE a.user_id = ? AND a.status IN ('confirmed', 'payment_submitted')
    ORDER BY a.created_at DESC
  `;
  db.query(sql, [userId], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// Get projects sold by user (seller/owner)
app.get('/api/projects/sold/:userId', (req, res) => {
  const { userId } = req.params;
  const sql = `
    SELECT a.id as application_id, a.status, a.created_at as sold_at, a.message,
           p.id as project_id, p.title, p.description, p.budget, p.thumbnail_url,
           u.name as buyer_name, u.email as buyer_email
    FROM applications a
    INNER JOIN projects p ON a.target_id = p.id AND a.type = 'project'
    LEFT JOIN users u ON a.user_id = u.id
    WHERE p.user_id = ? AND a.status IN ('confirmed', 'payment_submitted')
    ORDER BY a.created_at DESC
  `;
  db.query(sql, [userId], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// PUT/DELETE Ideas & Projects
app.put('/api/ideas/:id', (req, res) => {
  const { id } = req.params;
  const { title, description, budget } = req.body;
  db.query('UPDATE ideas SET title = ?, description = ?, budget = ? WHERE id = ?', [title, description, budget, id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Idea updated successfully' });
  });
});

app.delete('/api/ideas/:id', (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM applications WHERE type = "idea" AND target_id = ?', [id], () => {
    db.query('DELETE FROM idea_images WHERE idea_id = ?', [id], () => {
      db.query('DELETE FROM idea_sectors WHERE idea_id = ?', [id], () => {
        db.query('DELETE FROM ideas WHERE id = ?', [id], (err) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ message: 'Idea deleted successfully' });
        });
      });
    });
  });
});

app.put('/api/projects/:id', (req, res) => {
  const { id } = req.params;
  const { title, description, budget } = req.body;
  db.query('UPDATE projects SET title = ?, description = ?, budget = ? WHERE id = ?', [title, description, budget, id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Project updated successfully' });
  });
});

app.delete('/api/projects/:id', (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM applications WHERE type = "project" AND target_id = ?', [id], () => {
    db.query('DELETE FROM project_gallery WHERE project_id = ?', [id], () => {
      db.query('DELETE FROM project_documents WHERE project_id = ?', [id], () => {
        db.query('DELETE FROM project_sectors WHERE project_id = ?', [id], () => {
          db.query('DELETE FROM projects WHERE id = ?', [id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Project deleted successfully' });
          });
        });
      });
    });
  });
});

// --- APPLICATIONS API ---

app.post('/api/applications', upload.any(), (req, res) => {
  const { user_id, type, target_id, message, duration_months, monitoring_type, status, bid_price } = req.body;

  const parsedUserId = parseInt(user_id, 10);
  const parsedTargetId = parseInt(target_id, 10);

  if (isNaN(parsedUserId) || !type || isNaN(parsedTargetId)) {
    console.error('Validation failed. user_id:', user_id, 'type:', type, 'target_id:', target_id);
    return res.status(400).json({ error: 'User ID, type, and target ID are required and must be valid integers' });
  }

  const parsedDuration = parseInt(duration_months, 10);
  const finalDuration = isNaN(parsedDuration) ? 1 : parsedDuration;
  const finalMonitoringType = (monitoring_type && monitoring_type !== 'undefined') ? monitoring_type : 'Mingguan';
  const finalStatus = status || 'pending';

  const proposalFile = req.files?.find(f => f.fieldname === 'proposal');
  const attachmentFile = req.files?.find(f => f.fieldname === 'attachment');

  const proposal_url = proposalFile ? `/uploads/${proposalFile.filename}` : null;
  const attachment_url = attachmentFile ? `/uploads/${attachmentFile.filename}` : null;

  const sql = 'INSERT INTO applications (user_id, type, target_id, message, proposal_url, attachment_url, duration_months, monitoring_type, status, bid_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
  db.query(sql, [parsedUserId, type, parsedTargetId, message, proposal_url, attachment_url, finalDuration, finalMonitoringType, finalStatus, bid_price], (err, results) => {
    if (err) {
      console.error('DATABASE ERROR (Applications Insert):', err);
      return res.status(500).json({ error: err.message });
    }

    const applicationId = results.insertId;

    // Notify Idea/Project Owner
    const ownerSql = type === 'idea'
      ? 'SELECT user_id, title FROM ideas WHERE id = ?'
      : 'SELECT user_id, title FROM projects WHERE id = ?';

    db.query(ownerSql, [parsedTargetId], (oErr, oRes) => {
      if (!oErr && oRes.length > 0 && oRes[0].user_id) {
        const ownerId = oRes[0].user_id;
        const targetTitle = oRes[0].title;

        // System notifications for owners are removed to avoid duplicates
      }
    });

    // If the application status indicates payment submitted, notify all admins
    if (finalStatus === 'payment_submitted') {
      db.query('SELECT id, name FROM users WHERE role = ?', ['admin'], (admErr, admRes) => {
        if (!admErr && admRes.length > 0) {
          // Fetch applicant name for message
          db.query('SELECT name FROM users WHERE id = ?', [parsedUserId], (uErr, uRes) => {
            const buyerName = (!uErr && uRes.length > 0) ? uRes[0].name : 'Pengguna';
            const notifTitle = 'Pembayaran Diterima (Menunggu Konfirmasi)';
            const notifMessage = `Pembayaran untuk aplikasi #${applicationId} oleh ${buyerName} menunggu konfirmasi admin.`;
            admRes.forEach(a => {
              db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [a.id, 'payment', notifTitle, notifMessage]);
            });
          });
        }
      });
    }

    res.status(201).json({ id: applicationId, message: 'Application submitted successfully' });
  });
});

app.put('/api/applications/:id/status', (req, res) => {
  const { status } = req.body;
  const { id } = req.params;

  db.query('SELECT a.*, CASE WHEN a.type = "idea" THEN i.title ELSE p.title END as title FROM applications a LEFT JOIN ideas i ON a.target_id = i.id AND a.type = "idea" LEFT JOIN projects p ON a.target_id = p.id AND a.type = "project" WHERE a.id = ?', [id], (err, results) => {
    if (err || results.length === 0) return res.status(404).json({ error: 'Application not found' });

    const app = results[0];
    const updateSql = status === 'approved' 
      ? 'UPDATE applications SET status = ?, approved_at = NOW() WHERE id = ?'
      : 'UPDATE applications SET status = ? WHERE id = ?';
    
    db.query(updateSql, [status, id], (upErr) => {
      if (upErr) return res.status(500).json({ error: upErr.message });

      // Notify Applicant
      let title = 'Pengajuan Terupdate';
      let msg = `Pengajuan Anda untuk '${app.title}' telah diperbarui menjadi ${status}.`;

      if (status === 'approved') {
        title = 'Pengajuan Disetujui!';
        msg = `Selamat! Pengajuan Anda untuk '${app.title}' telah disetujui oleh pemilik ide. Pemilik ide akan menyelesaikan pembayaran dalam waktu 1 jam.`;
      } else if (status === 'rejected') {
        title = 'Pengajuan Ditolak';
        msg = `Mohon maaf, pengajuan Anda untuk '${app.title}' belum disetujui saat ini.`;
      } else if (status === 'canceled') {
        title = 'Pengajuan Dibatalkan';
        msg = `Pengajuan proposal Anda untuk '${app.title}' telah dibatalkan.`;
      }

      db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [
        app.user_id,
        'update',
        title,
        msg
      ]);

      res.json({ message: `Status updated to ${status}` });
    });
  });
});

// Submit PRD details for approved application
app.put('/api/applications/:id/prd', (req, res) => {
  const { id } = req.params;
  const { prd_design, prd_color, prd_features, prd_price } = req.body;
  
  const sql = `
    UPDATE applications 
    SET prd_design = ?, prd_color = ?, prd_features = ?, prd_price = ?, status = 'prd_submitted'
    WHERE id = ?
  `;
  db.query(sql, [prd_design, prd_color, prd_features, prd_price, id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    
    // Notify the Idea Owner that PRD is submitted and ready for payment
    db.query('SELECT a.*, i.user_id as owner_id, i.title FROM applications a INNER JOIN ideas i ON a.target_id = i.id WHERE a.id = ?', [id], (appErr, appRes) => {
      if (!appErr && appRes.length > 0) {
        const app = appRes[0];
        db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [
          app.owner_id,
          'update',
          'Dokumen PRD Dikirim!',
          `Dokumen PRD untuk ide '${app.title}' telah diisi. Silakan cek detail pengajuan untuk melakukan pembayaran.`
        ]);
      }
    });
    
    res.json({ message: 'PRD submitted successfully. Ready for payment!' });
  });
});

// Submit payment confirmation
app.put('/api/applications/:id/pay', (req, res) => {
  const { id } = req.params;
  const sql = "UPDATE applications SET status = 'payment_submitted', updated_at = NOW() WHERE id = ?";
  db.query(sql, [id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    // After updating status, notify all admins about the submitted payment
    db.query('SELECT a.id AS app_id, a.user_id, a.type, CASE WHEN a.type = "idea" THEN i.title ELSE p.title END as title FROM applications a LEFT JOIN ideas i ON a.target_id = i.id AND a.type = "idea" LEFT JOIN projects p ON a.target_id = p.id AND a.type = "project" WHERE a.id = ?', [id], (selErr, selRes) => {
      if (selErr || selRes.length === 0) {
        return res.json({ message: 'Payment submitted successfully. Waiting for admin confirmation.' });
      }
      const appRecord = selRes[0];
      db.query('SELECT id, name FROM users WHERE role = ?', ['admin'], (admErr, admRes) => {
        if (!admErr && admRes.length > 0) {
          db.query('SELECT name FROM users WHERE id = ?', [appRecord.user_id], (uErr, uRes) => {
            const buyerName = (!uErr && uRes.length > 0) ? uRes[0].name : 'Pengguna';
            const notifTitle = 'Pembayaran Diterima (Menunggu Konfirmasi)';
            const notifMessage = appRecord.type === 'project'
              ? `Pembayaran untuk proyek '${appRecord.title}' oleh ${buyerName} menunggu konfirmasi admin.`
              : `Pembayaran untuk '${appRecord.title}' oleh ${buyerName} menunggu konfirmasi admin.`;
            admRes.forEach(a => {
              db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [a.id, 'payment', notifTitle, notifMessage]);
            });
          });
        }
        return res.json({ message: 'Payment submitted successfully. Waiting for admin confirmation.' });
      });
    });
  });
});

// Admin confirms payment and starts project monitoring
app.put('/api/admin/applications/:id/confirm-payment', (req, res) => {
  const { id } = req.params;
  
  db.query('SELECT a.*, CASE WHEN a.type = "idea" THEN i.title ELSE p.title END as title FROM applications a LEFT JOIN ideas i ON a.target_id = i.id AND a.type = "idea" LEFT JOIN projects p ON a.target_id = p.id AND a.type = "project" WHERE a.id = ?', [id], (err, results) => {
    if (err || results.length === 0) return res.status(404).json({ error: 'Application not found' });
    
    const app = results[0];
    const sql = "UPDATE applications SET status = 'confirmed' WHERE id = ?";
    db.query(sql, [id], (upErr) => {
      if (upErr) return res.status(500).json({ error: upErr.message });
      
      // Notify the applicant (buyer/creator) that payment is confirmed
      const notifTitle = 'Pembayaran Dikonfirmasi!';
      const notifMsg = app.type === 'project'
        ? `Pembayaran untuk proyek '${app.title}' telah dikonfirmasi. File proyek kini dapat diunduh di tab "Dibeli" pada menu Monitoring!`
        : `Pembayaran untuk '${app.title}' telah dikonfirmasi oleh Admin. Project telah resmi masuk tahap monitoring!`;
      db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [
        app.user_id,
        'payment',
        notifTitle,
        notifMsg
      ]);
      
      // If project purchase, notify the project owner (seller) about the sale
      if (app.type === 'project') {
        db.query('SELECT p.user_id as owner_id FROM projects p WHERE p.id = ?', [app.target_id], (ownerErr, ownerRes) => {
          if (!ownerErr && ownerRes.length > 0 && ownerRes[0].owner_id) {
            db.query('SELECT name FROM users WHERE id = ?', [app.user_id], (uErr, uRes) => {
              const buyerName = (!uErr && uRes.length > 0) ? uRes[0].name : 'Pengguna';
              db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [
                ownerRes[0].owner_id,
                'payment',
                'Proyek Anda Terjual!',
                `Proyek '${app.title}' telah dibeli oleh ${buyerName}. Cek tab Terjual di menu Monitoring untuk detail.`
              ]);
            });
          }
        });
      }
      
      res.json({ message: 'Payment confirmed successfully. Project is now active!' });
    });
  });
});

app.get('/api/applications/user/:userId', (req, res) => {
  const { userId } = req.params;
  const sql = `
    SELECT a.id, a.user_id, a.type, a.target_id, a.status, a.message, a.proposal_url, a.attachment_url, a.created_at,
           a.bid_price, a.approved_at,
           COALESCE(a.prd_design, i.prd_design) as prd_design,
           COALESCE(a.prd_color, i.prd_color) as prd_color,
           COALESCE(a.prd_features, i.prd_features) as prd_features,
           COALESCE(a.prd_price, i.prd_price) as prd_price,
           a.duration_months, a.monitoring_type,
           CASE 
             WHEN a.type = 'idea' THEN i.title 
             WHEN a.type = 'project' THEN p.title 
           END as title,
           p.app_file_url as project_app_file_url,
           p.app_file_name as project_app_file_name,
           p.budget as project_budget,
           u_owner.name as owner_name,
           u_owner.id as owner_id,
           u_owner.profile_picture as owner_profile_picture
    FROM applications a
    LEFT JOIN ideas i ON a.target_id = i.id AND a.type = 'idea'
    LEFT JOIN projects p ON a.target_id = p.id AND a.type = 'project'
    LEFT JOIN users u_owner ON (a.type = 'idea' AND i.user_id = u_owner.id) OR (a.type = 'project' AND p.user_id = u_owner.id)
    WHERE a.user_id = ?
    ORDER BY a.created_at DESC
  `;
  db.query(sql, [userId], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.get('/api/applications/incoming/:userId', (req, res) => {
  const { userId } = req.params;
  const sql = `
    SELECT a.id, a.user_id, a.type, a.target_id, a.status, a.message, a.proposal_url, a.attachment_url, a.created_at,
           a.bid_price, a.approved_at,
           COALESCE(a.prd_design, i.prd_design) as prd_design,
           COALESCE(a.prd_color, i.prd_color) as prd_color,
           COALESCE(a.prd_features, i.prd_features) as prd_features,
           COALESCE(a.prd_price, i.prd_price) as prd_price,
           a.duration_months, a.monitoring_type,
           u.name as applicant_name,
           u.profile_picture as applicant_profile_picture,
           p.budget as project_budget,
           CASE 
             WHEN a.type = 'idea' THEN i.title 
             WHEN a.type = 'project' THEN p.title 
           END as title,
           p.app_file_url as project_app_file_url,
           p.app_file_name as project_app_file_name
    FROM applications a
    INNER JOIN users u ON a.user_id = u.id
    LEFT JOIN ideas i ON a.target_id = i.id AND a.type = 'idea'
    LEFT JOIN projects p ON a.target_id = p.id AND a.type = 'project'
    WHERE (i.user_id = ? OR p.user_id = ?)
    ORDER BY a.created_at DESC
  `;
  db.query(sql, [userId, userId], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// Get single application by id (used by mobile client to poll payment status)
app.get('/api/applications/:id', (req, res) => {
  const { id } = req.params;
  const sql = `
    SELECT a.*, u.name AS buyer_name,
           COALESCE(p.title, i.title) AS title,
           p.budget AS project_budget, p.app_file_url, p.app_file_name
    FROM applications a
    LEFT JOIN users u ON a.user_id = u.id
    LEFT JOIN projects p ON a.target_id = p.id AND a.type = 'project'
    LEFT JOIN ideas i ON a.target_id = i.id AND a.type = 'idea'
    WHERE a.id = ?
    LIMIT 1
  `;
  db.query(sql, [id], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!results || results.length === 0) return res.status(404).json({ error: 'Application not found' });
    res.json(results[0]);
  });
});

// --- PROJECT REPORTS API ---
app.get('/api/applications/:id/reports', (req, res) => {
  const { id } = req.params;
  const sql = 'SELECT * FROM project_reports WHERE application_id = ? ORDER BY week_number ASC';
  db.query(sql, [id], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.post('/api/bug-reports', (req, res) => {
  const { user_id, title, description, application_id } = req.body;
  if (!user_id || !title) return res.status(400).json({ error: 'User ID and title are required' });

  const sql = 'INSERT INTO user_reports (user_id, application_id, report_type, title, description) VALUES (?, ?, ?, ?, ?)';
  db.query(sql, [user_id, application_id || null, 'bug', title, description || null], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });

    // Notify all admins
    db.query('SELECT id FROM users WHERE role = ?', ['admin'], (adminErr, adminRes) => {
      if (!adminErr && adminRes.length > 0) {
        const message = `Bug baru dilaporkan oleh user. Judul: ${title}`;
        adminRes.forEach((admin) => {
          db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [admin.id, 'admin', 'Laporan Bug Baru', message]);
        });
      }
    });

    res.status(201).json({ id: results.insertId, message: 'Bug report submitted successfully' });
  });
});

app.post('/api/applications/:id/monitoring-issue', (req, res) => {
  const { id } = req.params;
  const { user_id, title, description } = req.body;
  if (!user_id || !title) return res.status(400).json({ error: 'User ID and title are required' });

  const issueSql = 'INSERT INTO user_reports (user_id, application_id, report_type, title, description) VALUES (?, ?, ?, ?, ?)';
  db.query(issueSql, [user_id, id, 'monitoring_issue', title, description || null], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });

    // Notify all admins
    db.query('SELECT id FROM users WHERE role = ?', ['admin'], (adminErr, adminRes) => {
      if (!adminErr && adminRes.length > 0) {
        const message = `Pemilik ide melaporkan masalah monitoring untuk aplikasi #${id}: ${title}`;
        adminRes.forEach((admin) => {
          db.query('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [admin.id, 'admin', 'Laporan Monitoring Terhenti', message]);
        });
      }
    });

    res.status(201).json({ id: results.insertId, message: 'Monitoring issue report submitted successfully' });
  });
});

// Generate PRD PDF for an idea
app.get('/api/ideas/:id/prd-pdf', (req, res) => {
  const { id } = req.params;
  db.query('SELECT i.*, u.name as owner_name, u.email as owner_email FROM ideas i LEFT JOIN users u ON i.user_id = u.id WHERE i.id = ?', [id], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!results || results.length === 0) return res.status(404).json({ error: 'Idea not found' });

    const idea = results[0];

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PRD-idea-${idea.id}.pdf"`);
    doc.pipe(res);

    doc.fontSize(20).text(idea.title || 'Untitled Idea', { underline: true });
    doc.moveDown();
    doc.fontSize(12).text(`Pemilik: ${idea.owner_name || ''}`);
    doc.text(`Email: ${idea.owner_email || ''}`);
    const created = idea.created_at ? new Date(idea.created_at).toLocaleString('id-ID') : '';
    doc.text(`Tanggal dibuat: ${created}`);
    doc.moveDown();

    doc.fontSize(16).text('Product Requirement (PRD)', { underline: true });
    doc.moveDown();

    if (idea.prd_design) {
      doc.fontSize(14).text('Desain & Layout');
      doc.fontSize(12).text(idea.prd_design);
      doc.moveDown();
    }
    if (idea.prd_color) {
      doc.fontSize(14).text('Tema Warna / Brand');
      doc.fontSize(12).text(idea.prd_color);
      doc.moveDown();
    }
    if (idea.prd_features) {
      doc.fontSize(14).text('Fitur Utama');
      doc.fontSize(12).text(idea.prd_features);
      doc.moveDown();
    }

    if (!idea.prd_design && !idea.prd_color && !idea.prd_features) {
      doc.fontSize(12).text('PRD tidak tersedia untuk ide ini.');
    }

    doc.end();
  });
});

app.post('/api/applications/:id/reports', upload.any(), (req, res) => {
  const { id } = req.params;
  const { week_number, report_text } = req.body;

  if (!week_number) {
    return res.status(400).json({ error: 'Week number is required' });
  }

  const documentFile = req.files?.find(f => f.fieldname === 'document');
  const imageFile = req.files?.find(f => f.fieldname === 'image');
  const appFile = req.files?.find(f => f.fieldname === 'app_file');

  const document_url = documentFile ? `/uploads/${documentFile.filename}` : null;
  const image_url = imageFile ? `/uploads/${imageFile.filename}` : null;
  const app_file_url = appFile ? `/uploads/${appFile.filename}` : null;

  const sql = 'INSERT INTO project_reports (application_id, week_number, report_text, document_url, image_url, app_file_url) VALUES (?, ?, ?, ?, ?, ?)';
  db.query(sql, [id, week_number, report_text, document_url, image_url, app_file_url], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    
    if (app_file_url) {
      const updateSql = "UPDATE applications SET status = 'completed' WHERE id = ?";
      db.query(updateSql, [id], (updateErr) => {
        if (updateErr) console.error('Error updating application status:', updateErr);
        
        const notifySql = `
          SELECT i.user_id as owner_id, i.title as idea_title
          FROM applications a
          JOIN ideas i ON a.target_id = i.id
          WHERE a.id = ?
        `;
        db.query(notifySql, [id], (nErr, nRes) => {
          if (!nErr && nRes.length > 0) {
            const ownerId = nRes[0].owner_id;
            const ideaTitle = nRes[0].idea_title;
            const insertNotif = "INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'update', 'Proyek Selesai!', ?)";
            const msg = `Pengerjaan proyek '${ideaTitle}' telah selesai! Pengaju telah mengunggah file akhir aplikasi (APK/EXE/ZIP) dan siap untuk diunduh.`;
            db.query(insertNotif, [ownerId, msg]);
          }
        });
      });
    }

    res.status(201).json({ id: results.insertId, message: 'Report submitted successfully' });
  });
});

// --- FINISH PROJECT & CERTIFICATES API ---

app.post('/api/applications/:id/finish', (req, res) => {
  const { id } = req.params;
  const { rating } = req.body;
  if (!rating) return res.status(400).json({ error: 'Rating is required' });

  const sql = "UPDATE applications SET status = 'finished', rating = ?, finished_at = NOW() WHERE id = ? AND status = 'completed'";
  db.query(sql, [rating, id], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Application not found or not in completed status' });

    // Notify the applicant
    const notifySql = `
      SELECT a.user_id as applicant_id, i.title as idea_title
      FROM applications a
      JOIN ideas i ON a.target_id = i.id
      WHERE a.id = ?
    `;
    db.query(notifySql, [id], (nErr, nRes) => {
      if (!nErr && nRes.length > 0) {
        const applicantId = nRes[0].applicant_id;
        const ideaTitle = nRes[0].idea_title;
        const insertNotif = "INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'update', 'Proyek Selesai & Dinilai!', ?)";
        const msg = `Pemilik ide telah mengkonfirmasi penyelesaian proyek '${ideaTitle}' dan memberikan rating ${rating} Bintang! Sertifikat kini tersedia di profil Anda.`;
        db.query(insertNotif, [applicantId, msg]);
      }
    });
    res.json({ message: 'Project finished successfully' });
  });
});

app.get('/api/users/:id/certificates', (req, res) => {
  const { id } = req.params;
  const sql = `
    SELECT a.id, a.rating, a.finished_at, i.title as idea_title
    FROM applications a
    JOIN ideas i ON a.target_id = i.id
    WHERE a.user_id = ? AND a.status = 'finished'
    ORDER BY a.finished_at DESC
  `;
  db.query(sql, [id], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// --- CHAT API ---

// Send a chat message
app.post('/api/chat/send', (req, res) => {
  const { sender_id, receiver_id, message } = req.body;
  if (!sender_id || !receiver_id || !message) {
    return res.status(400).json({ error: 'Sender ID, Receiver ID, and message text are required' });
  }

  const sql = 'INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)';
  db.query(sql, [sender_id, receiver_id, message], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    
    // Real-time socket message delivery
    const receiverSocket = onlineUsers.get(String(receiver_id));
    if (receiverSocket) {
      io.to(receiverSocket).emit('receive-message', {
        id: results.insertId,
        sender_id,
        receiver_id,
        message,
        created_at: new Date().toISOString()
      });
    }

    res.status(201).json({ id: results.insertId, message: 'Message sent successfully' });
  });
});

// Get message history between two users
app.get('/api/chat/history/:user1/:user2', (req, res) => {
  const { user1, user2 } = req.params;
  const sql = `
    SELECT * FROM messages 
    WHERE (sender_id = ? AND receiver_id = ?) 
       OR (sender_id = ? AND receiver_id = ?)
    ORDER BY created_at ASC
  `;
  db.query(sql, [user1, user2, user2, user1], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// Get all active chat sessions with the last message and unread counts for a user
app.get('/api/chat/sessions/:userId', (req, res) => {
  const { userId } = req.params;
  const sql = `
    SELECT u.id as partner_id, u.name as partner_name, u.email as partner_email,
           m.message as lastMessage, m.created_at as lastTime, m.sender_id,
           (SELECT COUNT(*) FROM messages WHERE sender_id = u.id AND receiver_id = ? AND is_read = FALSE) as unread
    FROM messages m
    INNER JOIN users u ON (m.sender_id = u.id AND m.receiver_id = ?) OR (m.receiver_id = u.id AND m.sender_id = ?)
    WHERE m.id IN (
      SELECT MAX(id) 
      FROM messages 
      WHERE sender_id = ? OR receiver_id = ?
      GROUP BY LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id)
    )
    ORDER BY m.created_at DESC
  `;
  db.query(sql, [userId, userId, userId, userId, userId], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// Mark all messages from a partner to a user as read
app.put('/api/chat/read', (req, res) => {
  const { sender_id, receiver_id } = req.body;
  if (!sender_id || !receiver_id) {
    return res.status(400).json({ error: 'sender_id and receiver_id required' });
  }
  const sql = 'UPDATE messages SET is_read = TRUE WHERE sender_id = ? AND receiver_id = ?';
  db.query(sql, [sender_id, receiver_id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Messages marked as read' });
  });
});

// --- NOTIFICATIONS API ---

app.post('/api/notifications', (req, res) => {
  const { user_id, type, title, message } = req.body;
  if (!user_id || !title) return res.status(400).json({ error: 'User ID and title required' });

  const sql = 'INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)';
  db.query(sql, [user_id, type || 'system', title, message], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id: results.insertId, message: 'Notification created' });
  });
});

app.get('/api/notifications/user/:userId', (req, res) => {
  const { userId } = req.params;
  const sql = 'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC';
  db.query(sql, [userId], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.put('/api/notifications/read/:id', (req, res) => {
  db.query('UPDATE notifications SET is_read = TRUE WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Marked as read' });
  });
});

app.get('/api/sectors', (req, res) => {
  db.query('SELECT * FROM sectors', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

const PORT = process.env.PORT || 5000;

// --- SOCKET.IO WEBRTC SIGNALING ---
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log(`[Socket.IO] User connected: ${socket.id}`);

  // Register user ID to Socket ID
  socket.on('register', (userId) => {
    if (userId) {
      onlineUsers.set(String(userId), socket.id);
      console.log(`[Socket.IO] User ${userId} registered with socket ${socket.id}`);
    }
  });

  // Call user (Offer)
  socket.on('call-user', (data) => {
    console.log(`[Socket.IO] call-user event: from=${data.from} to=${data.userToCall}`);
    console.log(`[Socket.IO] Online users:`, Object.fromEntries(onlineUsers));
    const receiverSocket = onlineUsers.get(String(data.userToCall));
    if (receiverSocket) {
      console.log(`[Socket.IO] Forwarding incoming-call to socket ${receiverSocket}`);
      io.to(receiverSocket).emit('incoming-call', {
        signal: data.signalData,
        from: data.from,
        name: data.name
      });
    } else {
      console.log(`[Socket.IO] WARNING: User ${data.userToCall} is NOT online! Call cannot be delivered.`);
      // Notify caller that the user is offline
      socket.emit('call-failed', { reason: 'User is offline', userToCall: data.userToCall });
    }
  });

  // Answer call (Answer)
  socket.on('answer-call', (data) => {
    const callerSocket = onlineUsers.get(String(data.to));
    if (callerSocket) {
      io.to(callerSocket).emit('call-accepted', data.signal);
    }
  });

  // WebRTC Answer
  socket.on('webrtc-answer', (data) => {
    const callerSocket = onlineUsers.get(String(data.to));
    if (callerSocket) {
      io.to(callerSocket).emit('webrtc-answer', data.signal);
    }
  });

  // ICE Candidates
  socket.on('ice-candidate', (data) => {
    const targetSocket = onlineUsers.get(String(data.to));
    if (targetSocket) {
      io.to(targetSocket).emit('ice-candidate', { candidate: data.candidate, from: data.from });
    }
  });

  // End or Reject call
  socket.on('end-call', (data) => {
    const targetSocket = onlineUsers.get(String(data.to));
    if (targetSocket) {
      io.to(targetSocket).emit('call-ended');
    }
  });

  socket.on('disconnect', () => {
    for (let [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        onlineUsers.delete(userId);
        console.log(`[Socket.IO] User ${userId} disconnected`);
        break;
      }
    }
  });

  // Heartbeat: client can re-register periodically to stay in the map
  socket.on('ping-register', (userId) => {
    if (userId) {
      const existing = onlineUsers.get(String(userId));
      if (existing !== socket.id) {
        onlineUsers.set(String(userId), socket.id);
        console.log(`[Socket.IO] Heartbeat re-registered user ${userId} with socket ${socket.id}`);
      }
    }
  });
});

// Diagnostic: see who is currently online
app.get('/api/debug/online-users', (req, res) => {
  const users = {};
  for (const [userId, socketId] of onlineUsers.entries()) {
    users[userId] = socketId;
  }
  res.json({ onlineUsers: users, count: onlineUsers.size });
});
// ----------------------------------

// Global Error Handler to ensure JSON responses
app.use((err, req, res, next) => {
  console.error('SERVER ERROR:', err.stack);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Local Access: http://localhost:${PORT}`);
});
