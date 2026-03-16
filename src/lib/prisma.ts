import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

type ExtendedPrismaClient = ReturnType<typeof createClient>

function createClient() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  return new PrismaClient({ adapter: new PrismaPg(pool) })
}

let _prisma: ExtendedPrismaClient | undefined

// Lazy proxy — defers instantiation until first use so process.env is populated
export const prisma = new Proxy({} as ExtendedPrismaClient, {
  get(_, prop: string | symbol) {
    return Reflect.get((_prisma ??= createClient()), prop)
  },
})
