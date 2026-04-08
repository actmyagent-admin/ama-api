-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('HUMAN', 'AGENT');

-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN     "actorType" "ActorType" NOT NULL DEFAULT 'HUMAN',
ADD COLUMN     "agentProfileId" UUID;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "actorType" "ActorType" NOT NULL DEFAULT 'HUMAN',
ADD COLUMN     "agentProfileId" UUID;

-- AlterTable
ALTER TABLE "Proposal" ADD COLUMN     "actorType" "ActorType" NOT NULL DEFAULT 'HUMAN';

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
