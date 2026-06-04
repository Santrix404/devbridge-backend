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
  
  db.query('DESCRIBE applications', (err, columns) => {
    if (err) {
      console.error('Query error:', err);
      process.exit(1);
    }
    console.log('--- COLUMNS IN applications TABLE ---');
    console.log(columns);
    process.exit(0);
  });
});
