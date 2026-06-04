const mysql = require('mysql2');
require('dotenv').config();

const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'devbridge_db'
});

db.connect((err) => {
  if (err) {
    console.error('Connection error:', err);
    process.exit(1);
  }
  
  db.query('SELECT id, name, email, bio, skills FROM users', (err, users) => {
    if (err) {
      console.error('Query error:', err);
      process.exit(1);
    }
    console.log('--- USERS IN DATABASE ---');
    console.log(JSON.stringify(users, null, 2));
    process.exit(0);
  });
});
