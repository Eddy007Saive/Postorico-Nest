import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../config/prisma.service';
import { AuthService } from '../auth/auth.service';
import { MailService } from '../mail/mail.service';
import { MAX_MEMBRES_EQUIPE, RoleEquipe } from '../../common/utils/acces-equipe.util';

export interface MembreVue {
  id: string;
  email: string;
  nom: string | null;
  role: RoleEquipe;
  statut: 'invite' | 'actif';
  invite_le: Date;
  rejoint_le: Date | null;
}

const hacher = (jeton: string) => createHash('sha256').update(jeton).digest('hex');

/** Équipe d'un compte : le propriétaire invite jusqu'à MAX_MEMBRES_EQUIPE personnes, qui
 * gèrent ensuite le compte depuis le leur (bascule via le sélecteur de comptes). Seul le
 * hachage du jeton d'invitation est gardé en base ; le jeton lui-même ne vit que dans l'email. */
@Injectable()
export class EquipeService {
  private readonly logger = new Logger(EquipeService.name);
  private readonly frontendUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly mail: MailService,
    config: ConfigService,
  ) {
    this.frontendUrl = (config.get<string>('app.frontendUrl') || '').replace(/\/+$/, '');
  }

  async lister(compteId: string): Promise<{ membres: MembreVue[]; max: number }> {
    const lignes = await this.prisma.membres_equipe.findMany({
      where: { compte_id: compteId },
      orderBy: { invite_le: 'asc' },
    });
    const ids = lignes.map((l) => l.membre_id).filter((i): i is string => !!i);
    const noms = new Map(
      (ids.length ? await this.prisma.users.findMany({ where: { telegram_id: { in: ids } }, select: { telegram_id: true, nom: true } }) : []).map(
        (u) => [u.telegram_id, u.nom],
      ),
    );
    return {
      max: MAX_MEMBRES_EQUIPE,
      membres: lignes.map((l) => ({
        id: l.id,
        email: l.email,
        nom: l.membre_id ? (noms.get(l.membre_id) ?? null) : null,
        role: l.role as RoleEquipe,
        statut: l.statut as 'invite' | 'actif',
        invite_le: l.invite_le,
        rejoint_le: l.rejoint_le,
      })),
    };
  }

  async inviter(compteId: string, emailBrut: string, role: RoleEquipe): Promise<MembreVue> {
    const email = emailBrut.trim().toLowerCase();
    const compte = await this.prisma.users.findUnique({ where: { telegram_id: compteId }, select: { email: true, nom: true, langue: true } });
    if (!compte) throw new NotFoundException('Compte introuvable');
    if ((compte.email || '').toLowerCase() === email) throw new BadRequestException('C’est ton propre compte.');
    const deja = await this.prisma.membres_equipe.findFirst({ where: { compte_id: compteId, email } });
    if (deja) throw new BadRequestException(deja.statut === 'actif' ? 'Cette personne fait déjà partie de ton équipe.' : 'Une invitation est déjà en attente pour cet email.');
    const nb = await this.prisma.membres_equipe.count({ where: { compte_id: compteId } });
    if (nb >= MAX_MEMBRES_EQUIPE) {
      throw new BadRequestException(`Ton équipe est complète (${MAX_MEMBRES_EQUIPE} personnes au plus). Retire quelqu’un pour inviter une autre personne.`);
    }
    const jeton = randomBytes(32).toString('base64url');
    const ligne = await this.prisma.membres_equipe.create({
      data: { compte_id: compteId, email, role, jeton_hash: hacher(jeton), invite_par: compteId },
    });
    await this.envoyer(email, compte.nom || compte.email || 'Postorico', role, jeton, compte.langue);
    return { id: ligne.id, email, nom: null, role, statut: 'invite', invite_le: ligne.invite_le, rejoint_le: null };
  }

  /** Nouveau lien (l'ancien ne marche plus) pour une invitation encore en attente. */
  async renvoyer(compteId: string, id: string): Promise<void> {
    const ligne = await this.prisma.membres_equipe.findFirst({ where: { id, compte_id: compteId } });
    if (!ligne) throw new NotFoundException('Invitation introuvable');
    if (ligne.statut !== 'invite') throw new BadRequestException('Cette personne a déjà rejoint ton équipe.');
    const compte = await this.prisma.users.findUnique({ where: { telegram_id: compteId }, select: { email: true, nom: true, langue: true } });
    const jeton = randomBytes(32).toString('base64url');
    await this.prisma.membres_equipe.update({ where: { id }, data: { jeton_hash: hacher(jeton), invite_le: new Date() } });
    await this.envoyer(ligne.email, compte?.nom || compte?.email || 'Postorico', ligne.role, jeton, compte?.langue);
  }

  async changerRole(compteId: string, id: string, role: RoleEquipe): Promise<void> {
    const ligne = await this.prisma.membres_equipe.findFirst({ where: { id, compte_id: compteId } });
    if (!ligne) throw new NotFoundException('Membre introuvable');
    await this.prisma.membres_equipe.update({ where: { id }, data: { role } });
    this.auth.oublierEquipe(compteId, ligne.membre_id);
  }

  async retirer(compteId: string, id: string): Promise<void> {
    const ligne = await this.prisma.membres_equipe.findFirst({ where: { id, compte_id: compteId } });
    if (!ligne) throw new NotFoundException('Membre introuvable');
    await this.prisma.membres_equipe.delete({ where: { id } });
    this.auth.oublierEquipe(compteId, ligne.membre_id);
  }

  /** Ce que montre la page d'invitation avant connexion : de qui elle vient, pour quel rôle. */
  async invitation(jeton: string): Promise<{ compte: string; role: RoleEquipe; email: string; statut: string }> {
    const ligne = await this.prisma.membres_equipe.findUnique({ where: { jeton_hash: hacher(jeton) } });
    if (!ligne) throw new NotFoundException('Invitation introuvable ou expirée');
    const compte = await this.prisma.users.findUnique({ where: { telegram_id: ligne.compte_id }, select: { nom: true, email: true } });
    return { compte: compte?.nom || compte?.email || 'Postorico', role: ligne.role as RoleEquipe, email: ligne.email, statut: ligne.statut };
  }

  /** La personne connectée accepte l'invitation. L'email de son compte doit être celui
   * invité : un lien transféré ne donne pas accès au compte. */
  async rejoindre(personneId: string, jeton: string): Promise<{ compte_id: string; compte: string; role: RoleEquipe }> {
    const ligne = await this.prisma.membres_equipe.findUnique({ where: { jeton_hash: hacher(jeton) } });
    if (!ligne) throw new NotFoundException('Invitation introuvable ou expirée');
    if (ligne.compte_id === personneId) throw new BadRequestException('C’est ton propre compte.');
    const personne = await this.prisma.users.findUnique({ where: { telegram_id: personneId }, select: { email: true } });
    if ((personne?.email || '').toLowerCase() !== ligne.email) {
      throw new ForbiddenException(`Cette invitation est destinée à ${ligne.email}. Connecte-toi avec ce compte pour l’accepter.`);
    }
    await this.prisma.membres_equipe.update({
      where: { id: ligne.id },
      data: { membre_id: personneId, statut: 'actif', rejoint_le: new Date(), jeton_hash: null },
    });
    this.auth.oublierEquipe(ligne.compte_id, personneId);
    const compte = await this.prisma.users.findUnique({ where: { telegram_id: ligne.compte_id }, select: { nom: true, email: true } });
    this.logger.log(`Équipe : ${personneId} a rejoint ${ligne.compte_id} (${ligne.role})`);
    return { compte_id: ligne.compte_id, compte: compte?.nom || compte?.email || 'Postorico', role: ligne.role as RoleEquipe };
  }

  private async envoyer(email: string, nomCompte: string, role: string, jeton: string, langue: unknown): Promise<void> {
    const lien = `${this.frontendUrl}/rejoindre?jeton=${encodeURIComponent(jeton)}`;
    const { subject, html } = this.mail.invitationEquipeHtml(nomCompte, role, lien, langue);
    const r = await this.mail.sendEmail(email, subject, html);
    if (r.error) this.logger.warn(`Invitation équipe non envoyée à ${email} : ${r.error}`);
  }
}
