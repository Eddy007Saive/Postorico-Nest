import { UploadApiOptions, UploadApiResponse, v2 as cloudinary } from 'cloudinary';

/**
 * Envoi d'un gros fichier à Cloudinary par tranches, en attendant VRAIMENT la fin.
 *
 * Piège du SDK 2.x : `cloudinary.uploader.upload_large(chemin, options)` sans callback
 * renvoie un flux (Chunkable), pas une promesse — un `await` dessus rend la main tout de
 * suite. Le fichier temporaire était alors supprimé pendant l'envoi : erreur ENOENT qui
 * faisait tomber le serveur (constaté le 2026-10-08 sur l'import vidéo de la banque).
 * Seule la forme avec callback donne la réponse finale.
 *
 * Tranches : 5 Mo minimum exigés par Cloudinary (sauf la dernière) ; 20 Mo par défaut.
 */
export function envoyerGrosFichier(chemin: string, options: UploadApiOptions): Promise<UploadApiResponse> {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_large(
      chemin,
      { chunk_size: 20 * 1024 * 1024, timeout: 600_000, ...options },
      (err, res) => (err || !res ? reject(err || new Error('Envoi Cloudinary sans réponse')) : resolve(res)),
    );
  });
}
