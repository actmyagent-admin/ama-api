-- Seed extended categories for ActMyAgent
-- Run via: npx prisma migrate deploy  (or apply manually)

INSERT INTO "Category" ("id", "name", "slug", "createdAt", "updatedAt")
VALUES
  -- Tech & Engineering
  (gen_random_uuid(), 'Web App & SaaS',             'web-app-saas',      NOW(), NOW()),
  (gen_random_uuid(), 'DevOps & Infrastructure',    'devops',            NOW(), NOW()),
  (gen_random_uuid(), 'QA & Testing',               'qa-testing',        NOW(), NOW()),
  (gen_random_uuid(), 'Cybersecurity',              'cybersecurity',     NOW(), NOW()),
  (gen_random_uuid(), 'Database Administration',    'database',          NOW(), NOW()),
  (gen_random_uuid(), 'API Integration',            'api-integration',   NOW(), NOW()),

  -- Creative & Media
  (gen_random_uuid(), 'UI/UX Design',               'ui-ux',             NOW(), NOW()),
  (gen_random_uuid(), 'Photo Editing',              'photo-editing',     NOW(), NOW()),
  (gen_random_uuid(), 'Podcast Production',         'podcast',           NOW(), NOW()),
  (gen_random_uuid(), 'Music & Audio Production',   'music-audio',       NOW(), NOW()),
  (gen_random_uuid(), '3D Modeling & Animation',    '3d-animation',      NOW(), NOW()),
  (gen_random_uuid(), 'Presentation Design',        'presentation',      NOW(), NOW()),

  -- Arts & Visual Creation
  (gen_random_uuid(), 'Illustration & Digital Art', 'illustration',      NOW(), NOW()),
  (gen_random_uuid(), 'Logo & Brand Identity',      'logo-branding',     NOW(), NOW()),
  (gen_random_uuid(), 'Graphic Design',             'graphic-design',    NOW(), NOW()),
  (gen_random_uuid(), 'Motion Graphics & VFX',      'motion-graphics',   NOW(), NOW()),
  (gen_random_uuid(), '2D Animation',               '2d-animation',      NOW(), NOW()),
  (gen_random_uuid(), 'Comic & Storyboard Art',     'comic-storyboard',  NOW(), NOW()),
  (gen_random_uuid(), 'NFT & Generative Art',       'nft-art',           NOW(), NOW()),
  (gen_random_uuid(), 'Fashion & Textile Design',   'fashion-design',    NOW(), NOW()),
  (gen_random_uuid(), 'Interior & Space Design',    'interior-design',   NOW(), NOW()),
  (gen_random_uuid(), 'Architecture Visualization', 'architecture-viz',  NOW(), NOW()),

  -- Music & Audio Arts
  (gen_random_uuid(), 'Music Composition',          'music-composition', NOW(), NOW()),
  (gen_random_uuid(), 'Songwriting & Lyrics',       'songwriting',       NOW(), NOW()),
  (gen_random_uuid(), 'Beat Making & Mixing',       'beat-making',       NOW(), NOW()),
  (gen_random_uuid(), 'Sound Design',               'sound-design',      NOW(), NOW()),
  (gen_random_uuid(), 'Voice Over',                 'voice-over',        NOW(), NOW()),

  -- Game & Interactive
  (gen_random_uuid(), 'Game Design',                'game-design',       NOW(), NOW()),
  (gen_random_uuid(), 'Game Asset Creation',        'game-assets',       NOW(), NOW()),

  -- Writing & Content
  (gen_random_uuid(), 'Content Creation',           'content-creation',  NOW(), NOW()),
  (gen_random_uuid(), 'Technical Writing',          'technical-writing', NOW(), NOW()),
  (gen_random_uuid(), 'Translation & Localization', 'translation',       NOW(), NOW()),
  (gen_random_uuid(), 'Transcription',              'transcription',     NOW(), NOW()),
  (gen_random_uuid(), 'Proofreading & Editing',     'proofreading',      NOW(), NOW()),

  -- Marketing & Growth
  (gen_random_uuid(), 'Social Media Management',    'social-media',      NOW(), NOW()),
  (gen_random_uuid(), 'SEO Optimization',           'seo',               NOW(), NOW()),
  (gen_random_uuid(), 'Email Marketing',            'email-marketing',   NOW(), NOW()),
  (gen_random_uuid(), 'Paid Advertising',           'paid-ads',          NOW(), NOW()),
  (gen_random_uuid(), 'Sales & Lead Generation',    'sales-leads',       NOW(), NOW()),
  (gen_random_uuid(), 'E-commerce Management',      'ecommerce',         NOW(), NOW()),

  -- Finance & Business
  (gen_random_uuid(), 'Accounting & Bookkeeping',   'accounting',        NOW(), NOW()),
  (gen_random_uuid(), 'Tax Advisory',               'tax',               NOW(), NOW()),
  (gen_random_uuid(), 'Financial Analysis',         'financial-analysis',NOW(), NOW()),
  (gen_random_uuid(), 'Business Planning',          'business-planning', NOW(), NOW()),
  (gen_random_uuid(), 'Market Research',            'market-research',   NOW(), NOW()),

  -- Legal, Compliance & HR
  (gen_random_uuid(), 'Compliance Management',      'compliance',        NOW(), NOW()),
  (gen_random_uuid(), 'Contract Review',            'contract-review',   NOW(), NOW()),
  (gen_random_uuid(), 'HR & Recruitment',           'hr-recruitment',    NOW(), NOW()),

  -- Operations & Support
  (gen_random_uuid(), 'Customer Support',           'customer-support',  NOW(), NOW()),
  (gen_random_uuid(), 'Project Management',         'project-management',NOW(), NOW()),
  (gen_random_uuid(), 'Data Analysis & Reporting',  'data-analysis',     NOW(), NOW()),
  (gen_random_uuid(), 'Product Management',         'product-management',NOW(), NOW()),
  (gen_random_uuid(), 'Event Planning',             'event-planning',    NOW(), NOW()),

  -- Events & Celebrations
  (gen_random_uuid(), 'Event & Wedding Content',    'event-wedding',     NOW(), NOW()),

  -- Education & Research
  (gen_random_uuid(), 'Educational Content',        'education',         NOW(), NOW()),
  (gen_random_uuid(), 'Academic Research',          'academic-research', NOW(), NOW()),
  (gen_random_uuid(), 'Medical & Health Research',  'medical-research',  NOW(), NOW()),
  (gen_random_uuid(), 'Real Estate Research',       'real-estate',       NOW(), NOW())

ON CONFLICT ("slug") DO UPDATE
  SET "name" = EXCLUDED."name",
      "updatedAt" = NOW();
