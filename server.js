const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const slugify = require('slugify');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads dir exists
const uploadsDir = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'uploads')
  : path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Multer config
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

// App config
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
// Serve uploads from volume path when DATA_DIR is set
if (process.env.DATA_DIR) {
  app.use('/uploads', express.static(path.join(process.env.DATA_DIR, 'uploads')));
}
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: process.env.DATA_DIR || __dirname }),
  secret: 'blog-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Auth middleware
const requireAdmin = (req, res, next) => {
  if (req.session.adminId) return next();
  res.redirect('/admin/login');
};

// ─── Public Routes ────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 6;
  const offset = (page - 1) * limit;

  const articles = db.prepare(`
    SELECT id, title, slug, excerpt, thumbnail, created_at
    FROM articles WHERE published = 1
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);

  const total = db.prepare('SELECT COUNT(*) as count FROM articles WHERE published = 1').get().count;
  const totalPages = Math.ceil(total / limit);

  res.render('index', { articles, page, totalPages });
});

app.get('/article/:slug', (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE slug = ? AND published = 1').get(req.params.slug);
  if (!article) return res.status(404).render('404');

  const comments = db.prepare(`
    SELECT * FROM comments WHERE article_id = ? ORDER BY created_at DESC
  `).all(article.id);

  res.render('article', { article, comments, error: null, success: null });
});

app.post('/article/:slug/comment', (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE slug = ? AND published = 1').get(req.params.slug);
  if (!article) return res.status(404).render('404');

  const { author, content } = req.body;
  const comments = db.prepare('SELECT * FROM comments WHERE article_id = ? ORDER BY created_at DESC').all(article.id);

  if (!content || content.trim().length < 3) {
    return res.render('article', { article, comments, error: 'Comment is too short.', success: null });
  }
  if (content.trim().length > 2000) {
    return res.render('article', { article, comments, error: 'Comment is too long (max 2000 chars).', success: null });
  }

  const name = (author && author.trim()) ? author.trim().slice(0, 50) : 'Anonymous';
  db.prepare('INSERT INTO comments (article_id, author, content) VALUES (?, ?, ?)').run(article.id, name, content.trim());

  const updatedComments = db.prepare('SELECT * FROM comments WHERE article_id = ? ORDER BY created_at DESC').all(article.id);
  res.render('article', { article, comments: updatedComments, error: null, success: 'Comment posted!' });
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────

app.get('/admin/login', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.prepare('SELECT * FROM admin WHERE username = ?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    return res.render('admin/login', { error: 'Invalid credentials.' });
  }
  req.session.adminId = admin.id;
  res.redirect('/admin');
});

app.get('/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

app.get('/admin', requireAdmin, (req, res) => {
  const articles = db.prepare(`
    SELECT a.id, a.title, a.slug, a.published, a.created_at,
           COUNT(c.id) as comment_count
    FROM articles a
    LEFT JOIN comments c ON c.article_id = a.id
    GROUP BY a.id
    ORDER BY a.created_at DESC
  `).all();
  res.render('admin/dashboard', { articles });
});

app.get('/admin/new', requireAdmin, (req, res) => {
  res.render('admin/editor', { article: null, error: null });
});

app.post('/admin/new', requireAdmin, upload.single('thumbnail'), (req, res) => {
  const { title, excerpt, content, published } = req.body;

  if (!title || !content) {
    return res.render('admin/editor', { article: null, error: 'Title and content are required.' });
  }

  let slug = slugify(title, { lower: true, strict: true });
  // Ensure unique slug
  let slugBase = slug;
  let counter = 1;
  while (db.prepare('SELECT id FROM articles WHERE slug = ?').get(slug)) {
    slug = `${slugBase}-${counter++}`;
  }

  const thumbnail = req.file ? `/uploads/${req.file.filename}` : null;
  db.prepare(`
    INSERT INTO articles (title, slug, excerpt, content, thumbnail, published)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(title.trim(), slug, excerpt?.trim() || null, content.trim(), thumbnail, published === 'on' ? 1 : 0);

  res.redirect('/admin');
});

app.get('/admin/edit/:id', requireAdmin, (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).render('404');
  res.render('admin/editor', { article, error: null });
});

app.post('/admin/edit/:id', requireAdmin, upload.single('thumbnail'), (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).render('404');

  const { title, excerpt, content, published } = req.body;

  if (!title || !content) {
    return res.render('admin/editor', { article, error: 'Title and content are required.' });
  }

  let thumbnail = article.thumbnail;
  if (req.file) {
    // Remove old thumbnail
    if (article.thumbnail) {
      const oldPath = path.join(__dirname, 'public', article.thumbnail);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    thumbnail = `/uploads/${req.file.filename}`;
  }

  db.prepare(`
    UPDATE articles
    SET title = ?, excerpt = ?, content = ?, thumbnail = ?, published = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(title.trim(), excerpt?.trim() || null, content.trim(), thumbnail, published === 'on' ? 1 : 0, req.params.id);

  res.redirect('/admin');
});

app.post('/admin/delete/:id', requireAdmin, (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (article?.thumbnail) {
    const imgPath = path.join(__dirname, 'public', article.thumbnail);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }
  db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);
  res.redirect('/admin');
});

app.post('/admin/comment/delete/:id', requireAdmin, (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!comment) return res.redirect('/admin');
  const article = db.prepare('SELECT slug FROM articles WHERE id = ?').get(comment.article_id);
  db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
  if (article) res.redirect(`/article/${article.slug}`);
  else res.redirect('/admin');
});

app.post('/admin/toggle/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE articles SET published = NOT published WHERE id = ?').run(req.params.id);
  res.redirect('/admin');
});

// Change password
app.get('/admin/settings', requireAdmin, (req, res) => {
  res.render('admin/settings', { error: null, success: null });
});

app.post('/admin/settings', requireAdmin, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const admin = db.prepare('SELECT * FROM admin WHERE id = ?').get(req.session.adminId);

  if (!bcrypt.compareSync(currentPassword, admin.password)) {
    return res.render('admin/settings', { error: 'Current password is incorrect.', success: null });
  }
  if (newPassword.length < 6) {
    return res.render('admin/settings', { error: 'New password must be at least 6 characters.', success: null });
  }
  if (newPassword !== confirmPassword) {
    return res.render('admin/settings', { error: 'Passwords do not match.', success: null });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE admin SET password = ? WHERE id = ?').run(hash, req.session.adminId);
  res.render('admin/settings', { error: null, success: 'Password updated successfully.' });
});

app.use((req, res) => res.status(404).render('404'));

app.listen(PORT, () => {
  console.log(`Blog running at http://localhost:${PORT}`);
});
