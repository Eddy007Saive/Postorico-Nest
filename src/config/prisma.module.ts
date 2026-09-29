import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Déclare PrismaService UNE SEULE FOIS pour toute l'app — mêmes mécanique que MailModule /
 * ClaudeModule / ZernioModule. Avant ce module, 36 features déclaraient chacune leur propre
 * PrismaService dans leurs `providers`, ce qui créait 36 PrismaClient (donc 36 pools de
 * connexions) séparés au lieu d'un seul partagé, contrairement à ce que dit le commentaire de
 * PrismaService lui-même. */
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
