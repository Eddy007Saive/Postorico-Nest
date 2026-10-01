import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { ContenuEvenementService } from './contenu-evenement.service';

// Module feuille (aucun import métier) : importable par ContenusModule, PostsModule,
// CarrouselModule ET LateModule sans jamais fermer de cycle — voir le commentaire
// d'en-tête de ContenuEvenementService.
@Module({
  imports: [PrismaModule],
  providers: [ContenuEvenementService],
  exports: [ContenuEvenementService],
})
export class ContenuEvenementModule {}
