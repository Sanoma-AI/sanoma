import { createFileRoute } from "@tanstack/react-router";
import { Link } from "sanoma/site";
import { CredentialsForm } from "../components/credentials-form.tsx";

export const Route = createFileRoute("/sites/account/sign-in")({ component: SignIn });

function SignIn() {
  return (
    <>
      <CredentialsForm route="sign-in/email" submit="Sign in" />
      <Link to="/sites/account/sign-up">New here? Sign up</Link>
    </>
  );
}
