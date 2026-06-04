const mysql = require('mysql2');

const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'devbridge_db'
});

db.connect((err) => {
  if (err) {
    console.error('Connection error:', err);
    process.exit(1);
  }
  
  console.log('Connected to database.');

  db.query('SELECT id FROM users LIMIT 1', (err, users) => {
    if (err) {
      console.error('Error fetching users:', err);
      process.exit(1);
    }

    if (users.length === 0) {
      console.log('No users found. Please register an account first.');
      process.exit(0);
    }

    const firstUserId = users[0].id;
    console.log(`Setting owner of all ideas and projects to User ID: ${firstUserId}`);

    db.query('UPDATE ideas SET user_id = ? WHERE user_id IS NULL', [firstUserId], (err1, res1) => {
      console.log('Ideas updated:', res1?.affectedRows || 0);
      
      db.query('UPDATE projects SET user_id = ? WHERE user_id IS NULL', [firstUserId], (err2, res2) => {
        console.log('Projects updated:', res2?.affectedRows || 0);
        
        console.log('Legacy data fixed. Notifications should now trigger correctly.');
        process.exit(0);
      });
    });
  });
});
