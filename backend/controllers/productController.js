const path = require('path');
const { put, del } = require('@vercel/blob');
const Product = require('../models/Product');

async function uploadProductImage(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const pathname = `products/product-${uniqueSuffix}${ext}`;

  const blob = await put(pathname, file.buffer, {
    access: 'public',
    contentType: file.mimetype,
  });

  return blob.url;
}

async function deleteProductImage(imageUrl) {
  if (!imageUrl) return;
  try {
    await del(imageUrl);
  } catch (err) {
    // Ignore missing/legacy local URLs so product CRUD is not blocked
    console.error('Blob image delete skipped:', err.message);
  }
}

// GET /api/products  (public - used by the storefront)
async function getAllProducts(req, res) {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    res.json({ products });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error while fetching products' });
  }
}

// GET /api/products/:id
async function getProductById(req, res) {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json({ product });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// POST /api/products  (admin only, multipart/form-data with "image" file)
async function createProduct(req, res) {
  try {
    const { name, category, price, productCode, description, featured, isHero, heroOrder } = req.body;

    if (!name || !category || !price || !productCode) {
      return res.status(400).json({ message: 'name, category, price and productCode are required' });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'Product image is required' });
    }

    const imageUrl = await uploadProductImage(req.file);

    const product = await Product.create({
      name,
      category,
      price,
      productCode,
      description,
      imageUrl,
      featured: featured === undefined ? true : featured === 'true' || featured === true,
      isHero: isHero === 'true' || isHero === true,
      heroOrder: heroOrder !== undefined ? Number(heroOrder) : 0,
    });

    res.status(201).json({ product });
  } catch (err) {
    console.error(err);
    if (err.code === 11000) {
      return res.status(409).json({ message: 'A product with that product code already exists' });
    }
    res.status(500).json({ message: 'Server error while creating product' });
  }
}

// PUT /api/products/:id  (admin only, image optional on update)
async function updateProduct(req, res) {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const { name, category, price, productCode, description, featured, isHero, heroOrder } = req.body;

    if (name !== undefined) product.name = name;
    if (category !== undefined) product.category = category;
    if (price !== undefined) product.price = price;
    if (productCode !== undefined) product.productCode = productCode;
    if (description !== undefined) product.description = description;
    if (featured !== undefined) product.featured = featured === 'true' || featured === true;
    if (isHero !== undefined) product.isHero = isHero === 'true' || isHero === true;
    if (heroOrder !== undefined) product.heroOrder = Number(heroOrder);

    if (req.file) {
      const previousImageUrl = product.imageUrl;
      const newImageUrl = await uploadProductImage(req.file);
      product.imageUrl = newImageUrl;
      await deleteProductImage(previousImageUrl);
    }

    await product.save();
    res.json({ product });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error while updating product' });
  }
}

// PUT /api/products/reorder  (admin only, batch reorder hero products)
async function reorderProducts(req, res) {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ message: 'items array is required' });
    }

    const updates = items.map((item) =>
      Product.findByIdAndUpdate(item.id, {
        ...(item.isHero !== undefined && { isHero: Boolean(item.isHero) }),
        ...(item.heroOrder !== undefined && { heroOrder: Number(item.heroOrder) }),
      })
    );

    await Promise.all(updates);
    const products = await Product.find().sort({ createdAt: -1 });
    res.json({ message: 'Products reordered successfully', products });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error while reordering products' });
  }
}

// DELETE /api/products/:id  (admin only)
async function deleteProduct(req, res) {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    await deleteProductImage(product.imageUrl);

    await product.deleteOne();
    res.json({ message: 'Product deleted', id: req.params.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error while deleting product' });
  }
}

module.exports = {
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  reorderProducts,
  deleteProduct,
};
