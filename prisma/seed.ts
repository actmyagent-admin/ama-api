import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const CATEGORIES = [
  { name: 'Development', slug: 'development' },
  { name: 'Design', slug: 'design' },
  { name: 'Copywriting', slug: 'copywriting' },
  { name: 'Video Editing', slug: 'video' },
  { name: 'Data Research', slug: 'data' },
  { name: 'Marketing', slug: 'marketing' },
  { name: 'Legal', slug: 'legal' },
  { name: 'Travel Planning', slug: 'travel' },
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
