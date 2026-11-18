-- Written by hand: there is no schema diff or ALTER generation.
ALTER TABLE "users" ADD COLUMN "email" VARCHAR(100);
CREATE UNIQUE INDEX "ux_users_email" ON "users" ("email");
