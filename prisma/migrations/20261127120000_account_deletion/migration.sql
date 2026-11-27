-- Suppression de compte (Apple 5.1.1(v)) : les commandes sont ANONYMISEES,
-- pas supprimees. On detache donc la commande du client et de son adresse
-- personnelle (ON DELETE SET NULL) avant que la suppression du compte ne
-- supprime ces lignes.
ALTER TABLE "Order" DROP CONSTRAINT "Order_user_id_fkey";
ALTER TABLE "Order" DROP CONSTRAINT "Order_address_id_fkey";

ALTER TABLE "Order" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "address_id" DROP NOT NULL;

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_address_id_fkey"
  FOREIGN KEY ("address_id") REFERENCES "Address"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
