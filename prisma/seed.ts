import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const CATEGORIES = [
  // Tech & Engineering
  { name: 'Development', slug: 'development' },
  { name: 'Web App & SaaS', slug: 'web-app-saas' },
  { name: 'DevOps & Infrastructure', slug: 'devops' },
  { name: 'QA & Testing', slug: 'qa-testing' },
  { name: 'Cybersecurity', slug: 'cybersecurity' },
  { name: 'Database Administration', slug: 'database' },
  { name: 'API Integration', slug: 'api-integration' },

  // Creative & Media
  { name: 'Design', slug: 'design' },
  { name: 'UI/UX Design', slug: 'ui-ux' },
  { name: 'Video Editing', slug: 'video' },
  { name: 'Photo Editing', slug: 'photo-editing' },
  { name: 'Podcast Production', slug: 'podcast' },
  { name: 'Music & Audio Production', slug: 'music-audio' },
  { name: '3D Modeling & Animation', slug: '3d-animation' },
  { name: 'Presentation Design', slug: 'presentation' },

  // Arts & Visual Creation
  { name: 'Illustration & Digital Art', slug: 'illustration' },
  { name: 'Logo & Brand Identity', slug: 'logo-branding' },
  { name: 'Graphic Design', slug: 'graphic-design' },
  { name: 'Motion Graphics & VFX', slug: 'motion-graphics' },
  { name: '2D Animation', slug: '2d-animation' },
  { name: 'Comic & Storyboard Art', slug: 'comic-storyboard' },
  { name: 'NFT & Generative Art', slug: 'nft-art' },
  { name: 'Fashion & Textile Design', slug: 'fashion-design' },
  { name: 'Interior & Space Design', slug: 'interior-design' },
  { name: 'Architecture Visualization', slug: 'architecture-viz' },

  // Music & Audio Arts
  { name: 'Music Composition', slug: 'music-composition' },
  { name: 'Songwriting & Lyrics', slug: 'songwriting' },
  { name: 'Beat Making & Mixing', slug: 'beat-making' },
  { name: 'Sound Design', slug: 'sound-design' },
  { name: 'Voice Over', slug: 'voice-over' },

  // Game & Interactive
  { name: 'Game Design', slug: 'game-design' },
  { name: 'Game Asset Creation', slug: 'game-assets' },

  // Writing & Content
  { name: 'Copywriting', slug: 'copywriting' },
  { name: 'Content Creation', slug: 'content-creation' },
  { name: 'Technical Writing', slug: 'technical-writing' },
  { name: 'Translation & Localization', slug: 'translation' },
  { name: 'Transcription', slug: 'transcription' },
  { name: 'Proofreading & Editing', slug: 'proofreading' },

  // Marketing & Growth
  { name: 'Marketing', slug: 'marketing' },
  { name: 'Social Media Management', slug: 'social-media' },
  { name: 'SEO Optimization', slug: 'seo' },
  { name: 'Email Marketing', slug: 'email-marketing' },
  { name: 'Paid Advertising', slug: 'paid-ads' },
  { name: 'Sales & Lead Generation', slug: 'sales-leads' },
  { name: 'E-commerce Management', slug: 'ecommerce' },

  // Finance & Business
  { name: 'Accounting & Bookkeeping', slug: 'accounting' },
  { name: 'Tax Advisory', slug: 'tax' },
  { name: 'Financial Analysis', slug: 'financial-analysis' },
  { name: 'Business Planning', slug: 'business-planning' },
  { name: 'Market Research', slug: 'market-research' },

  // Legal, Compliance & HR
  { name: 'Legal', slug: 'legal' },
  { name: 'Compliance Management', slug: 'compliance' },
  { name: 'Contract Review', slug: 'contract-review' },
  { name: 'HR & Recruitment', slug: 'hr-recruitment' },

  // Operations & Support
  { name: 'Customer Support', slug: 'customer-support' },
  { name: 'Project Management', slug: 'project-management' },
  { name: 'Data Research', slug: 'data' },
  { name: 'Data Analysis & Reporting', slug: 'data-analysis' },
  { name: 'Product Management', slug: 'product-management' },
  { name: 'Event Planning', slug: 'event-planning' },
  { name: 'Travel Planning', slug: 'travel' },

  // Events & Celebrations
  { name: 'Event & Wedding Content', slug: 'event-wedding' },

  // Education & Research
  { name: 'Educational Content', slug: 'education' },
  { name: 'Academic Research', slug: 'academic-research' },
  { name: 'Medical & Health Research', slug: 'medical-research' },
  { name: 'Real Estate Research', slug: 'real-estate' },
]

async function main() {
  console.log('Seeding categories...')
  for (const cat of CATEGORIES) {
    await prisma.category.upsert({
      where: { slug: cat.slug },
      update: { name: cat.name },
      create: { name: cat.name, slug: cat.slug },
    })
    console.log(`  ✓ ${cat.name} (${cat.slug})`)
  }
  console.log('Done.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
