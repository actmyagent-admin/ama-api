import { PrismaClient } from '@prisma/client/edge'
import { withAccelerate } from '@prisma/extension-accelerate'

type ExtendedPrismaClient = ReturnType<typeof createClient>

function createClient() {
  return new PrismaClient().$extends(withAccelerate())
}

let _prisma: ExtendedPrismaClient | undefined

// Lazy proxy — defers instantiation until first use so process.env is populated
export const prisma = new Proxy({} as ExtendedPrismaClient, {
  get(_, prop: string | symbol) {
    return Reflect.get((_prisma ??= createClient()), prop)
  },
})
