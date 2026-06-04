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
  
  db.query('SELECT id, title, user_id FROM projects', (err, projects) => {
    if (err) {
      console.error('Projects query error:', err);
      process.exit(1);
    }
    console.log('--- PROJECTS IN DATABASE ---');
    console.log(JSON.stringify(projects, null, 2));

    db.query('SELECT id, title, user_id FROM ideas', (err2, ideas) => {
      if (err2) {
        console.error('Ideas query error:', err2);
        process.exit(1);
      }
      console.log('--- IDEAS IN DATABASE ---');
      console.log(JSON.stringify(ideas, null, 2));
      process.exit(0);
    });
  });
});
